import type { OrderAuthoritySource } from "../domain/enums.js";
import type { ClientOrderId, ExchangeOrderId, ExecutionId, IntentId } from "../domain/ids.js";
import { makeClientOrderId, sha256Hex } from "../domain/ids.js";
import type { OrderIntent } from "../domain/types.js";
import {
  type DecimalString,
  decimalAdd,
  decimalCmp,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import { canonicalSerializeToUtf8 } from "../persistence/canonical-json.js";
import { isCanonicalGenerationString } from "../persistence/durable-envelope.js";

export const INTENT_REGISTRY_SCHEMA_VERSION = "phase3-intent-registry-1";

// PREPARED: durable write-ahead record exists; the send may or may not have happened.
// UNKNOWN: the send may have reached the venue. Both block until reconciled with evidence.
export type IntentStatus = "PREPARED" | "NOT_SENT" | "REJECTED" | "UNKNOWN" | "LINKED";

export type IntentAuthority = {
  source: OrderAuthoritySource;
  evidenceId: string;
};

export type RecordedExecution = {
  executionId: ExecutionId;
  exchangeOrderId: ExchangeOrderId;
  quantity: DecimalString;
  price: DecimalString;
};

export type IntentRecord = {
  intent: OrderIntent;
  status: IntentStatus;
  requestFingerprint: string;
  exchangeOrderId: ExchangeOrderId | null;
  authority: IntentAuthority | null;
  executions: RecordedExecution[];
  executedQuantity: DecimalString;
  reasonCodes: string[];
};

export type IntentRegistryState = {
  schemaVersion: typeof INTENT_REGISTRY_SCHEMA_VERSION;
  records: IntentRecord[];
};

export type IntentLink = {
  exchangeOrderId: ExchangeOrderId;
  authority: IntentAuthority;
  executions: RecordedExecution[];
  reasonCodes: string[];
};

export class IntentRegistryError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(reasonCode);
    this.name = "IntentRegistryError";
    this.reasonCode = reasonCode;
  }
}

const STATUSES = new Set<string>(["PREPARED", "NOT_SENT", "REJECTED", "UNKNOWN", "LINKED"]);
const UNRESOLVED_STATUSES = new Set<IntentStatus>(["PREPARED", "UNKNOWN"]);
const ALLOWED_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  PREPARED: ["NOT_SENT", "REJECTED", "UNKNOWN", "LINKED"],
  UNKNOWN: ["LINKED"],
  NOT_SENT: [],
  REJECTED: [],
  LINKED: [],
};
const PURPOSES = new Set<string>([
  "GRID_ENTRY",
  "GRID_EXIT",
  "RISK_REDUCTION",
  "EMERGENCY_FLATTEN",
  "CANCEL",
]);
const SIDES = new Set<string>(["BUY", "SELL"]);
const ORDER_TYPES = new Set<string>(["LIMIT", "MARKET"]);
const TIME_IN_FORCES = new Set<string>(["GTC", "IOC", "FOK", "POST_ONLY"]);
const AUTHORITY_SOURCES = new Set<string>(["ACK", "AUTHORITATIVE_OBSERVATION"]);

const STATE_KEYS = ["records", "schemaVersion"];
const RECORD_KEYS = [
  "authority",
  "exchangeOrderId",
  "executedQuantity",
  "executions",
  "intent",
  "reasonCodes",
  "requestFingerprint",
  "status",
];
const INTENT_KEYS = [
  "anchorEpoch",
  "clientOrderId",
  "createdAt",
  "experimentId",
  "intentId",
  "leaseGeneration",
  "logicalLevelId",
  "price",
  "purpose",
  "quantity",
  "reduceOnly",
  "runId",
  "scopeKey",
  "side",
  "timeInForce",
  "type",
];
const AUTHORITY_KEYS = ["evidenceId", "source"];
const EXECUTION_KEYS = ["exchangeOrderId", "executionId", "price", "quantity"];

// Fingerprint over every intent field, so a resubmission under the same intent ID with
// different content is detectable.
export function intentFingerprint(intent: OrderIntent): string {
  return sha256Hex(canonicalSerializeToUtf8(intent));
}

// Returns the first reason a value is not a placeable order intent with a deterministic
// client order ID, or null when it is.
export function placeIntentProblem(value: unknown): string | null {
  if (!isPlainObject(value) || !hasExactKeys(value, INTENT_KEYS)) {
    return "INVALID_INTENT_FIELDS";
  }
  const stringFields = [
    "intentId",
    "experimentId",
    "runId",
    "scopeKey",
    "anchorEpoch",
    "createdAt",
  ] as const;
  if (stringFields.some((field) => !isNonEmptyString(value[field]))) {
    return "INVALID_INTENT_FIELDS";
  }
  if (value.logicalLevelId !== null && !isNonEmptyString(value.logicalLevelId)) {
    return "INVALID_INTENT_FIELDS";
  }
  if (typeof value.purpose !== "string" || !PURPOSES.has(value.purpose)) {
    return "INVALID_INTENT_FIELDS";
  }
  if (value.purpose === "CANCEL") {
    return "CANCEL_IS_NOT_A_PLACE";
  }
  if (typeof value.side !== "string" || !SIDES.has(value.side)) {
    return "INVALID_INTENT_FIELDS";
  }
  if (typeof value.type !== "string" || !ORDER_TYPES.has(value.type)) {
    return "INVALID_INTENT_FIELDS";
  }
  if (
    value.timeInForce !== null &&
    (typeof value.timeInForce !== "string" || !TIME_IN_FORCES.has(value.timeInForce))
  ) {
    return "INVALID_INTENT_FIELDS";
  }
  if (!isPositiveDecimal(value.quantity)) {
    return "INVALID_INTENT_FIELDS";
  }
  if (value.type === "LIMIT" ? !isPositiveDecimal(value.price) : value.price !== null) {
    return "INVALID_INTENT_FIELDS";
  }
  if (typeof value.reduceOnly !== "boolean") {
    return "INVALID_INTENT_FIELDS";
  }
  if (
    typeof value.leaseGeneration !== "string" ||
    !isCanonicalGenerationString(value.leaseGeneration)
  ) {
    return "INVALID_INTENT_FIELDS";
  }
  const expectedClientOrderId = makeClientOrderId({
    scopeKey: value.scopeKey as string,
    anchorEpoch: value.anchorEpoch as string,
    logicalLevelId: value.logicalLevelId as string | null,
    purpose: value.purpose,
    intentId: value.intentId as string,
  });
  if (value.clientOrderId !== expectedClientOrderId) {
    return "CLIENT_ORDER_ID_NOT_DETERMINISTIC";
  }
  return null;
}

export class IntentRegistry {
  private readonly records = new Map<IntentId, IntentRecord>();
  private readonly byClientOrderId = new Map<ClientOrderId, IntentId>();
  private readonly byExchangeOrderId = new Map<ExchangeOrderId, IntentId>();
  private readonly byExecutionId = new Map<ExecutionId, IntentId>();

  get(intentId: IntentId): IntentRecord | null {
    const record = this.records.get(intentId);
    return record === undefined ? null : structuredClone(record);
  }

  list(): IntentRecord[] {
    return [...this.records.keys()]
      .sort(compareStrings)
      .map((intentId) => structuredClone(this.require(intentId)));
  }

  unresolved(): IntentRecord[] {
    return this.list().filter((record) => UNRESOLVED_STATUSES.has(record.status));
  }

  intentIdForClientOrderId(clientOrderId: ClientOrderId): IntentId | null {
    return this.byClientOrderId.get(clientOrderId) ?? null;
  }

  intentIdForExchangeOrderId(exchangeOrderId: ExchangeOrderId): IntentId | null {
    return this.byExchangeOrderId.get(exchangeOrderId) ?? null;
  }

  intentIdForExecutionId(executionId: ExecutionId): IntentId | null {
    return this.byExecutionId.get(executionId) ?? null;
  }

  prepare(intent: OrderIntent): IntentRecord {
    const problem = placeIntentProblem(intent);
    if (problem !== null) {
      throw new IntentRegistryError(problem);
    }
    if (this.records.has(intent.intentId)) {
      throw new IntentRegistryError("INTENT_ALREADY_REGISTERED");
    }
    const clientOrderId = intent.clientOrderId as ClientOrderId;
    if (this.byClientOrderId.has(clientOrderId)) {
      throw new IntentRegistryError("CLIENT_ORDER_ID_COLLISION");
    }
    const record: IntentRecord = {
      intent: structuredClone(intent),
      status: "PREPARED",
      requestFingerprint: intentFingerprint(intent),
      exchangeOrderId: null,
      authority: null,
      executions: [],
      executedQuantity: "0",
      reasonCodes: [],
    };
    this.records.set(intent.intentId, record);
    this.byClientOrderId.set(clientOrderId, intent.intentId);
    return structuredClone(record);
  }

  markNotSent(intentId: IntentId, reasonCodes: readonly string[]): IntentRecord {
    return this.transition(intentId, "NOT_SENT", reasonCodes);
  }

  markRejected(intentId: IntentId, reasonCodes: readonly string[]): IntentRecord {
    return this.transition(intentId, "REJECTED", reasonCodes);
  }

  markUnknown(intentId: IntentId, reasonCodes: readonly string[]): IntentRecord {
    return this.transition(intentId, "UNKNOWN", reasonCodes);
  }

  // Links an intent to one exchange order. Every check runs before any state changes.
  link(intentId: IntentId, link: IntentLink): IntentRecord {
    const record = this.require(intentId);
    assertTransition(record.status, "LINKED");
    if (!isNonEmptyString(link.exchangeOrderId)) {
      throw new IntentRegistryError("INVALID_EXCHANGE_ORDER_ID");
    }
    const owner = this.byExchangeOrderId.get(link.exchangeOrderId);
    if (owner !== undefined && owner !== intentId) {
      throw new IntentRegistryError("EXCHANGE_ORDER_ID_COLLISION");
    }
    const executions = normalizeExecutions(link.executions, link.exchangeOrderId);
    for (const execution of executions) {
      if (this.byExecutionId.has(execution.executionId)) {
        throw new IntentRegistryError("EXECUTION_ID_COLLISION");
      }
    }
    const executedQuantity = sumExecutions(executions);
    if (decimalCmp(executedQuantity, record.intent.quantity) > 0) {
      throw new IntentRegistryError("EXECUTION_OVERFILL");
    }

    record.status = "LINKED";
    record.exchangeOrderId = link.exchangeOrderId;
    record.authority = { source: link.authority.source, evidenceId: link.authority.evidenceId };
    record.executions = executions;
    record.executedQuantity = executedQuantity;
    record.reasonCodes = [...link.reasonCodes];
    this.byExchangeOrderId.set(link.exchangeOrderId, intentId);
    for (const execution of executions) {
      this.byExecutionId.set(execution.executionId, intentId);
    }
    return structuredClone(record);
  }

  exportState(): IntentRegistryState {
    return { schemaVersion: INTENT_REGISTRY_SCHEMA_VERSION, records: this.list() };
  }

  // Strict import: any structural or cross-record inconsistency throws, never repairs.
  static fromState(value: unknown): IntentRegistry {
    if (!isPlainObject(value) || !hasExactKeys(value, STATE_KEYS)) {
      throw new IntentRegistryError("IMPORT_INVALID_STATE");
    }
    if (value.schemaVersion !== INTENT_REGISTRY_SCHEMA_VERSION) {
      throw new IntentRegistryError("IMPORT_SCHEMA_VERSION_MISMATCH");
    }
    if (!Array.isArray(value.records)) {
      throw new IntentRegistryError("IMPORT_INVALID_STATE");
    }
    const registry = new IntentRegistry();
    let previousIntentId: string | null = null;
    for (const raw of value.records) {
      const record = parseRecord(raw);
      const intentId = record.intent.intentId;
      if (previousIntentId !== null && compareStrings(previousIntentId, intentId) >= 0) {
        throw new IntentRegistryError("IMPORT_RECORDS_NOT_SORTED");
      }
      previousIntentId = intentId;
      registry.adopt(record);
    }
    return registry;
  }

  private adopt(record: IntentRecord): void {
    const intentId = record.intent.intentId;
    const clientOrderId = record.intent.clientOrderId as ClientOrderId;
    if (this.byClientOrderId.has(clientOrderId)) {
      throw new IntentRegistryError("CLIENT_ORDER_ID_COLLISION");
    }
    if (record.exchangeOrderId !== null && this.byExchangeOrderId.has(record.exchangeOrderId)) {
      throw new IntentRegistryError("EXCHANGE_ORDER_ID_COLLISION");
    }
    if (record.executions.some((execution) => this.byExecutionId.has(execution.executionId))) {
      throw new IntentRegistryError("EXECUTION_ID_COLLISION");
    }
    this.records.set(intentId, record);
    this.byClientOrderId.set(clientOrderId, intentId);
    if (record.exchangeOrderId !== null) {
      this.byExchangeOrderId.set(record.exchangeOrderId, intentId);
    }
    for (const execution of record.executions) {
      this.byExecutionId.set(execution.executionId, intentId);
    }
  }

  private transition(
    intentId: IntentId,
    next: Exclude<IntentStatus, "LINKED" | "PREPARED">,
    reasonCodes: readonly string[],
  ): IntentRecord {
    const record = this.require(intentId);
    assertTransition(record.status, next);
    record.status = next;
    record.reasonCodes = [...reasonCodes];
    return structuredClone(record);
  }

  private require(intentId: IntentId): IntentRecord {
    const record = this.records.get(intentId);
    if (record === undefined) {
      throw new IntentRegistryError("INTENT_NOT_REGISTERED");
    }
    return record;
  }
}

function assertTransition(from: IntentStatus, to: IntentStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new IntentRegistryError(`INVALID_TRANSITION:${from}->${to}`);
  }
}

function normalizeExecutions(
  executions: readonly RecordedExecution[],
  exchangeOrderId: ExchangeOrderId,
): RecordedExecution[] {
  const sorted = executions
    .map((execution) => ({
      executionId: execution.executionId,
      exchangeOrderId: execution.exchangeOrderId,
      quantity: execution.quantity,
      price: execution.price,
    }))
    .sort((left, right) => compareStrings(left.executionId, right.executionId));
  for (const [index, execution] of sorted.entries()) {
    if (
      !isNonEmptyString(execution.executionId) ||
      execution.exchangeOrderId !== exchangeOrderId ||
      !isPositiveDecimal(execution.quantity) ||
      !isPositiveDecimal(execution.price)
    ) {
      throw new IntentRegistryError("INVALID_EXECUTION");
    }
    if (index > 0 && sorted[index - 1]?.executionId === execution.executionId) {
      throw new IntentRegistryError("DUPLICATE_EXECUTION_ID");
    }
  }
  return sorted;
}

function sumExecutions(executions: readonly RecordedExecution[]): DecimalString {
  return executions.reduce((sum, execution) => decimalAdd(sum, execution.quantity), "0");
}

function parseRecord(raw: unknown): IntentRecord {
  if (!isPlainObject(raw) || !hasExactKeys(raw, RECORD_KEYS)) {
    throw new IntentRegistryError("IMPORT_INVALID_RECORD");
  }
  if (placeIntentProblem(raw.intent) !== null) {
    throw new IntentRegistryError("IMPORT_INVALID_INTENT");
  }
  const intent = raw.intent as OrderIntent;
  if (typeof raw.status !== "string" || !STATUSES.has(raw.status)) {
    throw new IntentRegistryError("IMPORT_INVALID_STATUS");
  }
  const status = raw.status as IntentStatus;
  const requestFingerprint = intentFingerprint(intent);
  if (raw.requestFingerprint !== requestFingerprint) {
    throw new IntentRegistryError("IMPORT_FINGERPRINT_MISMATCH");
  }
  if (!Array.isArray(raw.reasonCodes) || !raw.reasonCodes.every(isNonEmptyString)) {
    throw new IntentRegistryError("IMPORT_INVALID_RECORD");
  }

  const linked = status === "LINKED";
  if (
    linked !== isNonEmptyString(raw.exchangeOrderId) ||
    (!linked && raw.exchangeOrderId !== null)
  ) {
    throw new IntentRegistryError("IMPORT_LINK_INCONSISTENT");
  }
  const authority = parseAuthority(raw.authority);
  if (linked !== (authority !== null)) {
    throw new IntentRegistryError("IMPORT_LINK_INCONSISTENT");
  }

  if (!Array.isArray(raw.executions)) {
    throw new IntentRegistryError("IMPORT_INVALID_RECORD");
  }
  if (!linked && raw.executions.length > 0) {
    throw new IntentRegistryError("IMPORT_LINK_INCONSISTENT");
  }
  const parsedExecutions = raw.executions.map(parseExecution);
  const exchangeOrderId = (raw.exchangeOrderId as ExchangeOrderId | null) ?? "";
  let executions: RecordedExecution[];
  try {
    executions = normalizeExecutions(parsedExecutions, exchangeOrderId);
  } catch {
    throw new IntentRegistryError("IMPORT_INVALID_EXECUTION");
  }
  if (canonicalSerializeToUtf8(executions) !== canonicalSerializeToUtf8(parsedExecutions)) {
    throw new IntentRegistryError("IMPORT_EXECUTIONS_NOT_SORTED");
  }
  const executedQuantity = sumExecutions(executions);
  if (raw.executedQuantity !== executedQuantity) {
    throw new IntentRegistryError("IMPORT_EXECUTED_QUANTITY_MISMATCH");
  }
  if (decimalCmp(executedQuantity, intent.quantity) > 0) {
    throw new IntentRegistryError("IMPORT_EXECUTION_OVERFILL");
  }

  return {
    intent: structuredClone(intent),
    status,
    requestFingerprint,
    exchangeOrderId: raw.exchangeOrderId as ExchangeOrderId | null,
    authority,
    executions,
    executedQuantity,
    reasonCodes: [...(raw.reasonCodes as string[])],
  };
}

function parseAuthority(raw: unknown): IntentAuthority | null {
  if (raw === null) {
    return null;
  }
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(raw, AUTHORITY_KEYS) ||
    typeof raw.source !== "string" ||
    !AUTHORITY_SOURCES.has(raw.source) ||
    !isNonEmptyString(raw.evidenceId)
  ) {
    throw new IntentRegistryError("IMPORT_INVALID_AUTHORITY");
  }
  return { source: raw.source as OrderAuthoritySource, evidenceId: raw.evidenceId };
}

function parseExecution(raw: unknown): RecordedExecution {
  if (
    !isPlainObject(raw) ||
    !hasExactKeys(raw, EXECUTION_KEYS) ||
    typeof raw.executionId !== "string" ||
    typeof raw.exchangeOrderId !== "string" ||
    typeof raw.quantity !== "string" ||
    typeof raw.price !== "string"
  ) {
    throw new IntentRegistryError("IMPORT_INVALID_EXECUTION");
  }
  return {
    executionId: raw.executionId,
    exchangeOrderId: raw.exchangeOrderId,
    quantity: raw.quantity,
    price: raw.price,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareStrings);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveDecimal(value: unknown): value is DecimalString {
  return typeof value === "string" && isCanonicalDecimalString(value) && decimalCmp(value, "0") > 0;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
