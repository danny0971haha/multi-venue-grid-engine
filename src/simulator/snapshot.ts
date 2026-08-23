import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import {
  ALL_LEVELS,
  BUY_LEVELS,
  leaseGenerationToString,
  makeClientOrderId,
  makeIntentId,
  makeScopeKey,
  parseLeaseGeneration,
} from "../domain/ids.js";
import {
  type DecimalString,
  decimalAdd,
  decimalCmp,
  decimalSub,
  isCanonicalDecimalString,
} from "../math/decimal.js";
import type { SimulatorSnapshot } from "./engine.js";

const INTENT_PURPOSES = new Set([
  "GRID_ENTRY",
  "GRID_EXIT",
  "RISK_REDUCTION",
  "EMERGENCY_FLATTEN",
  "CANCEL",
]);
const SIDES = new Set(["BUY", "SELL"]);
const ORDER_TYPES = new Set(["LIMIT", "MARKET"]);
const TIME_IN_FORCES = new Set(["GTC", "IOC", "FOK", "POST_ONLY"]);
const OWNERSHIPS = new Set(["OWNED", "UNOWNED", "AMBIGUOUS"]);

const AUTHORITY_SOURCES = new Set(["ACK", "AUTHORITATIVE_OBSERVATION"]);
const EXECUTION_INTEGRITY_FAULT_CODES = new Set([
  "NON_POSITIVE_EXECUTION_QUANTITY",
  "NON_POSITIVE_EXECUTION_PRICE",
  "EXECUTION_OVERFILL",
  "EXECUTION_ID_COLLISION",
  "ORDER_ID_COLLISION",
]);
const GENERATED_ORDER_PREFIX = "sim-ord-";
const GENERATED_EXECUTION_PREFIX = "sim-exec-";

export const SIMULATOR_SCHEMA_VERSION = "phase1-simulator-2" as const;

export class SnapshotImportError extends Error {
  readonly code: string;
  readonly disposition = "BLOCK_RISK_INCREASE" as const;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SnapshotImportError";
    this.code = code;
  }
}

export function assertValidSimulatorSnapshot(value: unknown): SimulatorSnapshot {
  const snapshot = asRecord(value, "snapshot");
  if (snapshot.schemaVersion !== SIMULATOR_SCHEMA_VERSION) {
    throw new SnapshotImportError("INVALID_SCHEMA", "SNAPSHOT_SCHEMA_MISMATCH");
  }
  rejectLiveDecimal(snapshot, "snapshot");
  const init = asRecord(snapshot.init, "init");
  const config = asRecord(snapshot.config, "config");
  assertFrozenConfig(config);
  const expectedScopeKey = assertInit(init);
  if (typeof snapshot.entriesPlanned !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "ENTRIES_PLANNED_INVALID");
  }
  if (typeof snapshot.riskIncreaseBlocked !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "RISK_BLOCK_INVALID");
  }
  if (typeof snapshot.executionGap !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "EXECUTION_GAP_INVALID");
  }
  if (snapshot.executionConflict !== undefined && typeof snapshot.executionConflict !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "EXECUTION_CONFLICT_INVALID");
  }
  assertExecutionIntegrityFault(snapshot.executionIntegrityFault);
  if (typeof snapshot.snapshotStale !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "SNAPSHOT_STALE_INVALID");
  }
  assertNonNegativeInteger(snapshot.orderSeq, "orderSeq");
  assertNonNegativeInteger(snapshot.executionSeq, "executionSeq");

  const levels = asArray(snapshot.levels, "levels");
  const intents = asArray(snapshot.intents, "intents");
  const orders = asArray(snapshot.orders, "orders");
  const authorityLinks = asArray(snapshot.authorityLinks, "authorityLinks");
  const executions = asArray(snapshot.executions, "executions");
  const unknownWrites = asArray(snapshot.unknownWrites, "unknownWrites");
  assertPosition(asRecord(snapshot.position, "position"));
  assertAccount(asRecord(snapshot.account, "account"));

  const intentIds = new Set<string>();
  const intentRecords = new Map<string, Record<string, unknown>>();
  for (const [index, intent] of intents.entries()) {
    const record = asRecord(intent, `intents[${index}]`);
    const path = `intents[${index}]`;
    const intentId = requireString(record.intentId, `${path}.intentId`);
    if (intentIds.has(intentId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "DUPLICATE_INTENT_ID");
    }
    intentIds.add(intentId);
    intentRecords.set(intentId, record);
    assertCanonicalOrNull(record.price, `${path}.price`);
    assertNonNegativeCanonical(record.quantity, `${path}.quantity`);
    assertCurrentScopeIntent(record, init, expectedScopeKey, path);
  }

  const orderIds = new Set<string>();
  const orderRecords = new Map<string, Record<string, unknown>>();
  for (const [index, order] of orders.entries()) {
    const record = asRecord(order, `orders[${index}]`);
    const path = `orders[${index}]`;
    const exchangeOrderId = requireString(record.exchangeOrderId, `${path}.exchangeOrderId`);
    if (orderIds.has(exchangeOrderId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "DUPLICATE_EXCHANGE_ORDER_ID");
    }
    orderIds.add(exchangeOrderId);
    orderRecords.set(exchangeOrderId, record);
    assertCanonicalOrNull(record.price, `${path}.price`);
    const original = assertNonNegativeCanonical(
      record.originalQuantity,
      `${path}.originalQuantity`,
    );
    const executed = assertNonNegativeCanonical(
      record.executedQuantity,
      `${path}.executedQuantity`,
    );
    const remaining = assertNonNegativeCanonical(
      record.remainingQuantity,
      `${path}.remainingQuantity`,
    );
    if (decimalCmp(executed, original) > 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "EXECUTED_EXCEEDS_ORIGINAL");
    }
    const status = requireString(record.status, `${path}.status`);
    if (status === "CANCELLED") {
      if (decimalCmp(remaining, "0") !== 0) {
        throw new SnapshotImportError("QUANTITY_INVARIANT", "CANCELLED_REMAINING_NOT_ZERO");
      }
    } else if (decimalCmp(remaining, decimalSub(original, executed)) !== 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "REMAINING_MISMATCH");
    }
    assertOneOf(record.side, SIDES, `${path}.side`);
    assertOneOf(record.type, ORDER_TYPES, `${path}.type`);
    assertOneOf(record.purpose, INTENT_PURPOSES, `${path}.purpose`);
    if (record.ownership !== undefined) {
      assertOneOf(record.ownership, OWNERSHIPS, `${path}.ownership`);
    }
    if (record.logicalLevelId !== null && record.logicalLevelId !== undefined) {
      const logicalLevelId = requireString(record.logicalLevelId, `${path}.logicalLevelId`);
      if (!(ALL_LEVELS as readonly string[]).includes(logicalLevelId)) {
        throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}.logicalLevelId:UNKNOWN_LEVEL`);
      }
    }
    if (record.intentId === null) {
      continue;
    }
    const intentId = requireString(record.intentId, `${path}.intentId`);
    const intent = intentRecords.get(intentId);
    if (intent === undefined) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "ORDER_INTENT_MISSING");
    }
    assertOrderMatchesIntent(record, intent, path);
  }

  const executionIds = new Set<string>();
  const executionRecords = new Map<string, Record<string, unknown>>();
  for (const [index, execution] of executions.entries()) {
    const record = asRecord(execution, `executions[${index}]`);
    const path = `executions[${index}]`;
    const executionId = requireString(record.executionId, `${path}.executionId`);
    if (executionIds.has(executionId)) {
      throw new SnapshotImportError("DUPLICATE_EXECUTION_ID", "DUPLICATE_EXECUTION_ID");
    }
    executionIds.add(executionId);
    executionRecords.set(executionId, record);
    assertNonNegativeCanonical(record.price, `${path}.price`);
    assertNonNegativeCanonical(record.quantity, `${path}.quantity`);
    assertCanonicalOrNull(record.feeAmount, `${path}.feeAmount`);
    const exchangeOrderId = requireString(record.exchangeOrderId, `${path}.exchangeOrderId`);
    if (!orderIds.has(exchangeOrderId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "EXECUTION_ORDER_MISSING");
    }
  }

  for (const [index, unknown] of unknownWrites.entries()) {
    const record = asRecord(unknown, `unknownWrites[${index}]`);
    const intentId = requireString(record.intentId, `unknownWrites[${index}].intentId`);
    if (!intentIds.has(intentId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "UNKNOWN_WRITE_INTENT_MISSING");
    }
    assertCanonicalOrNull(record.price, `unknownWrites[${index}].price`);
    assertNonNegativeCanonical(record.quantity, `unknownWrites[${index}].quantity`);
  }

  assertAuthorityLinks(
    authorityLinks,
    intentRecords,
    orderRecords,
    expectedScopeKey,
    requireString(init.anchorEpoch, "init.anchorEpoch"),
  );

  const seenLevels = new Set<string>();
  for (const [index, level] of levels.entries()) {
    const record = asRecord(level, `levels[${index}]`);
    const logicalLevelId = requireString(record.logicalLevelId, `levels[${index}].logicalLevelId`);
    if (!(ALL_LEVELS as readonly string[]).includes(logicalLevelId)) {
      throw new SnapshotImportError("INVALID_SNAPSHOT", "UNKNOWN_LOGICAL_LEVEL");
    }
    if (seenLevels.has(logicalLevelId)) {
      throw new SnapshotImportError("INVALID_SNAPSHOT", "DUPLICATE_LOGICAL_LEVEL");
    }
    seenLevels.add(logicalLevelId);
    assertCanonical(record.theoreticalEntryPrice, `levels[${index}].theoreticalEntryPrice`);
    assertCanonical(record.normalizedEntryPrice, `levels[${index}].normalizedEntryPrice`);
    assertCanonical(record.theoreticalExitPrice, `levels[${index}].theoreticalExitPrice`);
    assertCanonical(record.normalizedExitPrice, `levels[${index}].normalizedExitPrice`);
    assertCanonicalOrNull(record.originalQuantity, `levels[${index}].originalQuantity`);
    const executed = assertNonNegativeCanonical(
      record.executedQuantity,
      `levels[${index}].executedQuantity`,
    );
    if (record.remainingQuantity !== null) {
      assertNonNegativeCanonical(record.remainingQuantity, `levels[${index}].remainingQuantity`);
    }
    if (record.originalQuantity !== null) {
      const original = assertNonNegativeCanonical(
        record.originalQuantity,
        `levels[${index}].originalQuantity`,
      );
      if (decimalCmp(executed, original) > 0) {
        throw new SnapshotImportError("QUANTITY_INVARIANT", "LEVEL_EXECUTED_EXCEEDS_ORIGINAL");
      }
    }
    assertCanonicalOrNull(record.weightedExecutionPrice, `levels[${index}].weightedExecutionPrice`);
    const entryExecuted = assertNonNegativeCanonical(
      record.entryExecutedQuantity,
      `levels[${index}].entryExecutedQuantity`,
    );
    const exitExecuted = assertNonNegativeCanonical(
      record.exitExecutedQuantity,
      `levels[${index}].exitExecutedQuantity`,
    );
    const openInventory = assertNonNegativeCanonical(
      record.openInventory,
      `levels[${index}].openInventory`,
    );
    if (decimalCmp(exitExecuted, entryExecuted) > 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "EXIT_EXCEEDS_ENTRY");
    }
    if (decimalCmp(openInventory, decimalSub(entryExecuted, exitExecuted)) !== 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "OPEN_INVENTORY_MISMATCH");
    }
    const entrySequence = requireSequence(
      record.entryMutationSequence,
      `levels[${index}].entryMutationSequence`,
    );
    const exitSequence = requireSequence(
      record.exitMutationSequence,
      `levels[${index}].exitMutationSequence`,
    );
    if (typeof record.entryIntentTerminal !== "boolean") {
      throw new SnapshotImportError("INVALID_SNAPSHOT", "ENTRY_INTENT_TERMINAL_INVALID");
    }
    if (typeof record.exitIntentTerminal !== "boolean") {
      throw new SnapshotImportError("INVALID_SNAPSHOT", "EXIT_INTENT_TERMINAL_INVALID");
    }
    assertIntentReference(
      record.entryIntentId,
      intentRecords,
      {
        expectedSequence: entrySequence,
        expectedPurpose: "GRID_ENTRY",
        expectedLevel: logicalLevelId,
      },
      `levels[${index}].entryIntentId`,
    );
    assertIntentReference(
      record.exitIntentId,
      intentRecords,
      {
        expectedSequence: exitSequence,
        expectedPurpose: "GRID_EXIT",
        expectedLevel: logicalLevelId,
      },
      `levels[${index}].exitIntentId`,
    );
    if (
      record.workingExchangeOrderId !== null &&
      !orderIds.has(
        requireString(record.workingExchangeOrderId, `levels[${index}].workingExchangeOrderId`),
      )
    ) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "WORKING_ORDER_MISSING");
    }
    const executionIdList = asArray(record.executionIds, `levels[${index}].executionIds`);
    const seenLevelExecutions = new Set<string>();
    for (const [execIndex, executionId] of executionIdList.entries()) {
      const id = requireString(executionId, `levels[${index}].executionIds[${execIndex}]`);
      if (seenLevelExecutions.has(id)) {
        throw new SnapshotImportError("DUPLICATE_EXECUTION_ID", "LEVEL_DUPLICATE_EXECUTION_ID");
      }
      seenLevelExecutions.add(id);
      if (!executionIds.has(id)) {
        throw new SnapshotImportError("DANGLING_IDENTITY", "LEVEL_EXECUTION_MISSING");
      }
    }
    reconcileLevelExecutions(record, executionRecords, orderRecords, `levels[${index}]`);
  }
  for (const logicalLevelId of ALL_LEVELS) {
    if (!seenLevels.has(logicalLevelId)) {
      throw new SnapshotImportError("INVALID_SNAPSHOT", `MISSING_LEVEL:${logicalLevelId}`);
    }
  }

  reconcileOrderExecutions(orderRecords, executionRecords);
  reconcileSignedPosition(asRecord(snapshot.position, "position"), levels);
  assertGeneratedSequenceNotBehind(
    snapshot.orderSeq,
    orderIds,
    GENERATED_ORDER_PREFIX,
    "ORDER_SEQ_BEHIND_IDENTITIES",
  );
  assertGeneratedSequenceNotBehind(
    snapshot.executionSeq,
    executionIds,
    GENERATED_EXECUTION_PREFIX,
    "EXECUTION_SEQ_BEHIND_IDENTITIES",
  );

  return value as SimulatorSnapshot;
}

function assertFrozenConfig(config: Record<string, unknown>): void {
  const expected = V01_EXPERIMENT_CONFIG;
  const keys = Object.keys(expected) as Array<keyof typeof expected>;
  for (const key of keys) {
    if (config[key] !== expected[key]) {
      throw new SnapshotImportError("FROZEN_ENVELOPE_MISMATCH", `CONFIG_MISMATCH:${key}`);
    }
    if (key !== "version" && key !== "gridLevels" && typeof expected[key] === "string") {
      assertCanonical(config[key], `config.${key}`);
    }
  }
}

function assertInit(init: Record<string, unknown>): string {
  const accountScope = requireString(init.accountScope, "init.accountScope");
  const venue = requireString(init.venue, "init.venue");
  const market = requireString(init.market, "init.market");
  const strategy = requireString(init.strategy, "init.strategy");
  let scopeKey: string;
  try {
    scopeKey = makeScopeKey(accountScope, venue, market, strategy);
  } catch {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "INVALID_SCOPE_IDENTITY");
  }
  requireString(init.anchorEpoch, "init.anchorEpoch");
  requireString(init.experimentId, "init.experimentId");
  requireString(init.runId, "init.runId");
  assertCanonicalLeaseGeneration(init.leaseGeneration, "init.leaseGeneration");
  assertCanonical(init.anchorPrice, "init.anchorPrice");
  assertNonNegativeCanonical(init.quantity, "init.quantity");
  const rules = asRecord(init.marketRules, "init.marketRules");
  assertCanonical(rules.priceTick, "init.marketRules.priceTick");
  assertCanonical(rules.quantityStep, "init.marketRules.quantityStep");
  assertCanonicalOrNull(rules.minQuantity, "init.marketRules.minQuantity");
  assertCanonicalOrNull(rules.maxQuantity, "init.marketRules.maxQuantity");
  assertCanonicalOrNull(rules.minNotional, "init.marketRules.minNotional");
  assertCanonicalOrNull(rules.maxNotional, "init.marketRules.maxNotional");
  return scopeKey;
}

function assertPosition(position: Record<string, unknown>): void {
  assertCanonical(position.quantity, "position.quantity");
  assertCanonicalOrNull(position.markPrice, "position.markPrice");
  assertCanonicalOrNull(position.notionalUsd, "position.notionalUsd");
  assertCanonicalOrNull(position.unrealizedPnlUsd, "position.unrealizedPnlUsd");
}

function assertAccount(account: Record<string, unknown>): void {
  assertCanonicalOrNull(account.equityUsd, "account.equityUsd");
  assertCanonicalOrNull(account.availableMarginUsd, "account.availableMarginUsd");
  assertCanonicalOrNull(account.realizedDailyPnlUsd, "account.realizedDailyPnlUsd");
  assertCanonicalOrNull(account.feesDailyUsd, "account.feesDailyUsd");
  assertCanonicalOrNull(account.fundingDailyUsd, "account.fundingDailyUsd");
}

function assertIntentReference(
  value: unknown,
  intentRecords: Map<string, Record<string, unknown>>,
  expected: {
    expectedSequence: string;
    expectedPurpose: string;
    expectedLevel: string;
  },
  path: string,
): void {
  if (value === null) {
    return;
  }
  const intentId = requireString(value, path);
  const intent = intentRecords.get(intentId);
  if (intent === undefined) {
    throw new SnapshotImportError("DANGLING_IDENTITY", `${path}:MISSING_INTENT`);
  }
  const sequence = intentId.split(":").at(-1);
  if (sequence !== expected.expectedSequence) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:SEQUENCE_MISMATCH`);
  }
  if (intent.purpose !== expected.expectedPurpose) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:PURPOSE_MISMATCH`);
  }
  if (intent.logicalLevelId !== expected.expectedLevel) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:LEVEL_MISMATCH`);
  }
}

function assertCurrentScopeIntent(
  record: Record<string, unknown>,
  init: Record<string, unknown>,
  expectedScopeKey: string,
  path: string,
): void {
  const experimentId = requireString(record.experimentId, `${path}.experimentId`);
  const runId = requireString(record.runId, `${path}.runId`);
  const scopeKey = requireString(record.scopeKey, `${path}.scopeKey`);
  const anchorEpoch = requireString(record.anchorEpoch, `${path}.anchorEpoch`);
  if (
    experimentId !== init.experimentId ||
    runId !== init.runId ||
    scopeKey !== expectedScopeKey ||
    anchorEpoch !== init.anchorEpoch
  ) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:INTENT_IDENTITY_MISMATCH`);
  }
  const purpose = requireString(record.purpose, `${path}.purpose`);
  assertOneOf(purpose, INTENT_PURPOSES, `${path}.purpose`);
  assertOneOf(record.side, SIDES, `${path}.side`);
  assertOneOf(record.type, ORDER_TYPES, `${path}.type`);
  if (record.timeInForce !== null) {
    assertOneOf(record.timeInForce, TIME_IN_FORCES, `${path}.timeInForce`);
  }
  if (typeof record.reduceOnly !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}.reduceOnly:NOT_BOOLEAN`);
  }
  const logicalLevelId =
    record.logicalLevelId === null
      ? null
      : requireString(record.logicalLevelId, `${path}.logicalLevelId`);
  if (logicalLevelId !== null && !(ALL_LEVELS as readonly string[]).includes(logicalLevelId)) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}.logicalLevelId:UNKNOWN_LEVEL`);
  }
  const intentId = requireString(record.intentId, `${path}.intentId`);
  const sequence = intentId.split(":").at(-1);
  if (sequence === undefined || !/^\d+$/.test(sequence)) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:INTENT_ID_MISMATCH`);
  }
  const expectedIntentId = makeIntentId({
    experimentId,
    runId,
    scopeKey,
    anchorEpoch,
    logicalLevelId,
    purpose,
    sequence,
  });
  if (intentId !== expectedIntentId) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:INTENT_ID_MISMATCH`);
  }
  const clientOrderId = requireString(record.clientOrderId, `${path}.clientOrderId`);
  const expectedClientOrderId = makeClientOrderId({
    scopeKey,
    anchorEpoch,
    logicalLevelId,
    purpose,
    intentId,
  });
  if (clientOrderId !== expectedClientOrderId) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:CLIENT_ORDER_ID_MISMATCH`);
  }
  assertCanonicalLeaseGeneration(record.leaseGeneration, `${path}.leaseGeneration`);
}

function assertAuthorityLinks(
  authorityLinks: unknown[],
  intentRecords: Map<string, Record<string, unknown>>,
  orderRecords: Map<string, Record<string, unknown>>,
  expectedScopeKey: string,
  expectedAnchorEpoch: string,
): void {
  const evidenceIds = new Set<string>();
  const authorityByOrder = new Set<string>();
  for (const [index, link] of authorityLinks.entries()) {
    const record = asRecord(link, `authorityLinks[${index}]`);
    const path = `authorityLinks[${index}]`;
    const evidenceId = requireString(record.evidenceId, `${path}.evidenceId`);
    if (evidenceIds.has(evidenceId)) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "DUPLICATE_AUTHORITY_EVIDENCE_ID");
    }
    evidenceIds.add(evidenceId);
    assertOneOf(record.source, AUTHORITY_SOURCES, `${path}.source`);
    const exchangeOrderId = requireString(record.exchangeOrderId, `${path}.exchangeOrderId`);
    const intentId = requireString(record.intentId, `${path}.intentId`);
    const clientOrderId = requireString(record.clientOrderId, `${path}.clientOrderId`);
    const scopeKey = requireString(record.scopeKey, `${path}.scopeKey`);
    const anchorEpoch = requireString(record.anchorEpoch, `${path}.anchorEpoch`);
    if (!orderRecords.has(exchangeOrderId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "AUTHORITY_ORDER_MISSING");
    }
    if (!intentRecords.has(intentId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "AUTHORITY_INTENT_MISSING");
    }
    if (authorityByOrder.has(exchangeOrderId)) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "CONFLICTING_ORDER_AUTHORITY");
    }
    authorityByOrder.add(exchangeOrderId);
    const order = orderRecords.get(exchangeOrderId);
    const intent = intentRecords.get(intentId);
    if (order === undefined || intent === undefined) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "AUTHORITY_LINK_MISSING");
    }
    if (order.intentId === null) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_ON_NULL_INTENT_ORDER");
    }
    if (order.intentId !== intentId) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_INTENT_MISMATCH");
    }
    if (
      order.clientOrderId !== clientOrderId ||
      intent.clientOrderId !== clientOrderId ||
      order.scopeKey !== scopeKey ||
      intent.scopeKey !== scopeKey ||
      order.anchorEpoch !== anchorEpoch ||
      intent.anchorEpoch !== anchorEpoch
    ) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_IDENTITY_MISMATCH");
    }
    if (scopeKey !== expectedScopeKey || anchorEpoch !== expectedAnchorEpoch) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_SCOPE_EPOCH_MISMATCH");
    }
    if (
      order.logicalLevelId !== intent.logicalLevelId ||
      order.purpose !== intent.purpose ||
      order.side !== intent.side
    ) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_STRUCTURAL_MISMATCH");
    }
    const orderQuantity = requireString(order.originalQuantity, `${path}.orderQuantity`);
    const intentQuantity = requireString(intent.quantity, `${path}.intentQuantity`);
    if (decimalCmp(orderQuantity, intentQuantity) !== 0) {
      throw new SnapshotImportError("INVALID_AUTHORITY", "AUTHORITY_QUANTITY_MISMATCH");
    }
  }
}

function assertOrderMatchesIntent(
  order: Record<string, unknown>,
  intent: Record<string, unknown>,
  path: string,
): void {
  if (
    order.logicalLevelId !== intent.logicalLevelId ||
    order.purpose !== intent.purpose ||
    order.side !== intent.side ||
    order.clientOrderId !== intent.clientOrderId ||
    order.scopeKey !== intent.scopeKey ||
    order.anchorEpoch !== intent.anchorEpoch
  ) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:ORDER_INTENT_IDENTITY_MISMATCH`);
  }
  const orderQuantity = requireString(order.originalQuantity, `${path}.originalQuantity`);
  const intentQuantity = requireString(intent.quantity, `${path}.intentQuantity`);
  if (decimalCmp(orderQuantity, intentQuantity) !== 0) {
    throw new SnapshotImportError("QUANTITY_INVARIANT", `${path}:ORDER_INTENT_QUANTITY_MISMATCH`);
  }
}

function reconcileOrderExecutions(
  orderRecords: Map<string, Record<string, unknown>>,
  executionRecords: Map<string, Record<string, unknown>>,
): void {
  const totals = new Map<string, DecimalString>();
  for (const execution of executionRecords.values()) {
    const exchangeOrderId = requireString(execution.exchangeOrderId, "execution.exchangeOrderId");
    const quantity = requireString(execution.quantity, "execution.quantity");
    totals.set(exchangeOrderId, decimalAdd(totals.get(exchangeOrderId) ?? "0", quantity));
  }
  for (const [exchangeOrderId, order] of orderRecords.entries()) {
    const executed = requireString(order.executedQuantity, "order.executedQuantity");
    const summed = totals.get(exchangeOrderId) ?? "0";
    if (decimalCmp(executed, summed) !== 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "EXECUTION_TOTAL_MISMATCH");
    }
  }
}

function reconcileLevelExecutions(
  level: Record<string, unknown>,
  executionRecords: Map<string, Record<string, unknown>>,
  orderRecords: Map<string, Record<string, unknown>>,
  path: string,
): void {
  const executionIdList = asArray(level.executionIds, `${path}.executionIds`);
  let entryExecuted = "0";
  let exitExecuted = "0";
  for (const executionId of executionIdList) {
    const id = requireString(executionId, `${path}.executionIds`);
    const execution = executionRecords.get(id);
    if (execution === undefined) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "LEVEL_EXECUTION_MISSING");
    }
    const exchangeOrderId = requireString(
      execution.exchangeOrderId,
      `${path}.execution.exchangeOrderId`,
    );
    const order = orderRecords.get(exchangeOrderId);
    if (order === undefined) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "LEVEL_EXECUTION_ORDER_MISSING");
    }
    if (order.logicalLevelId !== null && order.logicalLevelId !== level.logicalLevelId) {
      throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:EXECUTION_LEVEL_MISMATCH`);
    }
    const quantity = requireString(execution.quantity, `${path}.execution.quantity`);
    if (order.purpose === "GRID_ENTRY") {
      entryExecuted = decimalAdd(entryExecuted, quantity);
    } else if (order.purpose === "GRID_EXIT") {
      exitExecuted = decimalAdd(exitExecuted, quantity);
    }
  }
  if (
    decimalCmp(
      entryExecuted,
      requireString(level.entryExecutedQuantity, `${path}.entryExecuted`),
    ) !== 0 ||
    decimalCmp(exitExecuted, requireString(level.exitExecutedQuantity, `${path}.exitExecuted`)) !==
      0
  ) {
    throw new SnapshotImportError("QUANTITY_INVARIANT", "LEVEL_EXECUTION_TOTAL_MISMATCH");
  }
}

function reconcileSignedPosition(position: Record<string, unknown>, levels: unknown[]): void {
  let signed = "0";
  for (const [index, level] of levels.entries()) {
    const record = asRecord(level, `levels[${index}]`);
    const logicalLevelId = requireString(record.logicalLevelId, `levels[${index}].logicalLevelId`);
    const openInventory = requireString(record.openInventory, `levels[${index}].openInventory`);
    if ((BUY_LEVELS as readonly string[]).includes(logicalLevelId)) {
      signed = decimalAdd(signed, openInventory);
    } else {
      signed = decimalSub(signed, openInventory);
    }
  }
  const positionQuantity = requireString(position.quantity, "position.quantity");
  if (decimalCmp(signed, positionQuantity) !== 0) {
    throw new SnapshotImportError("QUANTITY_INVARIANT", "POSITION_INVENTORY_MISMATCH");
  }
}

function assertCanonicalLeaseGeneration(value: unknown, path: string): void {
  const raw = requireString(value, path);
  try {
    if (leaseGenerationToString(parseLeaseGeneration(raw)) !== raw) {
      throw new Error("NON_CANONICAL");
    }
  } catch {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:INVALID_LEASE_GENERATION`);
  }
}

function assertOneOf(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:INVALID_ENUM`);
  }
}

function rejectLiveDecimal(value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
    if (ctor === "Decimal") {
      throw new SnapshotImportError("INVALID_SNAPSHOT", `LIVE_DECIMAL:${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        rejectLiveDecimal(item, `${path}[${index}]`);
      });
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      rejectLiveDecimal(item, `${path}.${key}`);
    }
  }
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:NOT_OBJECT`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:NOT_ARRAY`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:NOT_STRING`);
  }
  return value;
}

function requireSequence(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new SnapshotImportError("MISSING_MUTATION_SEQUENCE", `${path}:INVALID_SEQUENCE`);
  }
  return value;
}

function assertExecutionIntegrityFault(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  const record = asRecord(value, "executionIntegrityFault");
  const code = requireString(record.code, "executionIntegrityFault.code");
  if (!EXECUTION_INTEGRITY_FAULT_CODES.has(code)) {
    throw new SnapshotImportError("MALFORMED_EXECUTION_INTEGRITY_FAULT", "UNKNOWN_FAULT_CODE");
  }
  if (record.executionId !== null) {
    requireString(record.executionId, "executionIntegrityFault.executionId");
  }
  requireString(record.exchangeOrderId, "executionIntegrityFault.exchangeOrderId");
}

function assertGeneratedSequenceNotBehind(
  sequence: unknown,
  identities: Set<string>,
  prefix: string,
  code: string,
): void {
  assertNonNegativeInteger(
    sequence,
    prefix === GENERATED_ORDER_PREFIX ? "orderSeq" : "executionSeq",
  );
  let maxGenerated = 0;
  for (const identity of identities) {
    const parsed = parseGeneratedSequence(identity, prefix);
    if (parsed !== null && parsed > maxGenerated) {
      maxGenerated = parsed;
    }
  }
  if (typeof sequence === "number" && sequence < maxGenerated) {
    throw new SnapshotImportError(code, `${prefix}COUNTER_BEHIND`);
  }
}

function parseGeneratedSequence(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) {
    return null;
  }
  const digits = id.slice(prefix.length);
  if (!/^\d+$/.test(digits)) {
    return null;
  }
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:NOT_NON_NEGATIVE_INTEGER`);
  }
}

function assertCanonical(value: unknown, path: string): DecimalString {
  if (typeof value !== "string" || !isCanonicalDecimalString(value)) {
    throw new SnapshotImportError("NON_CANONICAL_DECIMAL", `${path}:NON_CANONICAL_DECIMAL`);
  }
  return value;
}

function assertCanonicalOrNull(value: unknown, path: string): DecimalString | null {
  if (value === null) {
    return null;
  }
  return assertCanonical(value, path);
}

function assertNonNegativeCanonical(value: unknown, path: string): DecimalString {
  const canonical = assertCanonical(value, path);
  if (decimalCmp(canonical, "0") < 0) {
    throw new SnapshotImportError("QUANTITY_INVARIANT", `${path}:NEGATIVE`);
  }
  return canonical;
}
