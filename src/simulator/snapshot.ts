import { V01_EXPERIMENT_CONFIG } from "../domain/config.js";
import { ALL_LEVELS, makeScopeKey } from "../domain/ids.js";
import {
  decimalCmp,
  decimalSub,
  isCanonicalDecimalString,
  type DecimalString,
} from "../math/decimal.js";
import type { SimulatorSnapshot } from "./engine.js";

export const SIMULATOR_SCHEMA_VERSION = "phase1-simulator-1" as const;

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
  assertInit(init);
  if (typeof snapshot.entriesPlanned !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "ENTRIES_PLANNED_INVALID");
  }
  if (typeof snapshot.riskIncreaseBlocked !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "RISK_BLOCK_INVALID");
  }
  if (typeof snapshot.executionGap !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "EXECUTION_GAP_INVALID");
  }
  if (typeof snapshot.snapshotStale !== "boolean") {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "SNAPSHOT_STALE_INVALID");
  }
  assertNonNegativeInteger(snapshot.orderSeq, "orderSeq");
  assertNonNegativeInteger(snapshot.executionSeq, "executionSeq");

  const levels = asArray(snapshot.levels, "levels");
  const intents = asArray(snapshot.intents, "intents");
  const orders = asArray(snapshot.orders, "orders");
  const executions = asArray(snapshot.executions, "executions");
  const unknownWrites = asArray(snapshot.unknownWrites, "unknownWrites");
  assertPosition(asRecord(snapshot.position, "position"));
  assertAccount(asRecord(snapshot.account, "account"));

  const intentIds = new Set<string>();
  for (const [index, intent] of intents.entries()) {
    const record = asRecord(intent, `intents[${index}]`);
    const intentId = requireString(record.intentId, `intents[${index}].intentId`);
    if (intentIds.has(intentId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "DUPLICATE_INTENT_ID");
    }
    intentIds.add(intentId);
    assertCanonicalOrNull(record.price, `intents[${index}].price`);
    assertNonNegativeCanonical(record.quantity, `intents[${index}].quantity`);
    requireString(record.scopeKey, `intents[${index}].scopeKey`);
    requireString(record.anchorEpoch, `intents[${index}].anchorEpoch`);
  }

  const orderIds = new Set<string>();
  for (const [index, order] of orders.entries()) {
    const record = asRecord(order, `orders[${index}]`);
    const exchangeOrderId = requireString(
      record.exchangeOrderId,
      `orders[${index}].exchangeOrderId`,
    );
    if (orderIds.has(exchangeOrderId)) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "DUPLICATE_EXCHANGE_ORDER_ID");
    }
    orderIds.add(exchangeOrderId);
    assertCanonicalOrNull(record.price, `orders[${index}].price`);
    const original = assertNonNegativeCanonical(
      record.originalQuantity,
      `orders[${index}].originalQuantity`,
    );
    const executed = assertNonNegativeCanonical(
      record.executedQuantity,
      `orders[${index}].executedQuantity`,
    );
    assertNonNegativeCanonical(record.remainingQuantity, `orders[${index}].remainingQuantity`);
    if (decimalCmp(executed, original) > 0) {
      throw new SnapshotImportError("QUANTITY_INVARIANT", "EXECUTED_EXCEEDS_ORIGINAL");
    }
    if (
      record.intentId !== null &&
      !intentIds.has(requireString(record.intentId, `orders[${index}].intentId`))
    ) {
      throw new SnapshotImportError("DANGLING_IDENTITY", "ORDER_INTENT_MISSING");
    }
  }

  const executionIds = new Set<string>();
  for (const [index, execution] of executions.entries()) {
    const record = asRecord(execution, `executions[${index}]`);
    const executionId = requireString(record.executionId, `executions[${index}].executionId`);
    if (executionIds.has(executionId)) {
      throw new SnapshotImportError("DUPLICATE_EXECUTION_ID", "DUPLICATE_EXECUTION_ID");
    }
    executionIds.add(executionId);
    assertNonNegativeCanonical(record.price, `executions[${index}].price`);
    assertNonNegativeCanonical(record.quantity, `executions[${index}].quantity`);
    assertCanonicalOrNull(record.feeAmount, `executions[${index}].feeAmount`);
    const exchangeOrderId = requireString(
      record.exchangeOrderId,
      `executions[${index}].exchangeOrderId`,
    );
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
      intentIds,
      entrySequence,
      `levels[${index}].entryIntentId`,
    );
    assertIntentReference(
      record.exitIntentId,
      intentIds,
      exitSequence,
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
  }
  for (const logicalLevelId of ALL_LEVELS) {
    if (!seenLevels.has(logicalLevelId)) {
      throw new SnapshotImportError("INVALID_SNAPSHOT", `MISSING_LEVEL:${logicalLevelId}`);
    }
  }

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

function assertInit(init: Record<string, unknown>): void {
  const accountScope = requireString(init.accountScope, "init.accountScope");
  const venue = requireString(init.venue, "init.venue");
  const market = requireString(init.market, "init.market");
  const strategy = requireString(init.strategy, "init.strategy");
  try {
    makeScopeKey(accountScope, venue, market, strategy);
  } catch {
    throw new SnapshotImportError("INVALID_SNAPSHOT", "INVALID_SCOPE_IDENTITY");
  }
  requireString(init.anchorEpoch, "init.anchorEpoch");
  requireString(init.experimentId, "init.experimentId");
  requireString(init.runId, "init.runId");
  assertCanonical(init.anchorPrice, "init.anchorPrice");
  assertNonNegativeCanonical(init.quantity, "init.quantity");
  const rules = asRecord(init.marketRules, "init.marketRules");
  assertCanonical(rules.priceTick, "init.marketRules.priceTick");
  assertCanonical(rules.quantityStep, "init.marketRules.quantityStep");
  assertCanonicalOrNull(rules.minQuantity, "init.marketRules.minQuantity");
  assertCanonicalOrNull(rules.maxQuantity, "init.marketRules.maxQuantity");
  assertCanonicalOrNull(rules.minNotional, "init.marketRules.minNotional");
  assertCanonicalOrNull(rules.maxNotional, "init.marketRules.maxNotional");
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
  intentIds: Set<string>,
  expectedSequence: string,
  path: string,
): void {
  if (value === null) {
    return;
  }
  const intentId = requireString(value, path);
  if (!intentIds.has(intentId)) {
    throw new SnapshotImportError("DANGLING_IDENTITY", `${path}:MISSING_INTENT`);
  }
  const sequence = intentId.split(":").at(-1);
  if (sequence !== expectedSequence) {
    throw new SnapshotImportError("INVALID_SNAPSHOT", `${path}:SEQUENCE_MISMATCH`);
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
