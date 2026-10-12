import { isCanonicalGenerationString } from "../persistence/durable-envelope.js";
import { isCanonicalDecimalString } from "../math/decimal.js";
import { isWellFormedHaltId } from "./halt-id.js";
import type { DurableHaltRecord, HaltAcknowledgementLineage, HaltStatus } from "./types.js";
import { HALT_RECORD_SCHEMA_VERSION } from "./types.js";

const HALT_STATUSES = new Set<HaltStatus>([
  "RUNNING",
  "HALTING",
  "HALTED_FLAT",
  "HALTED_UNFLAT",
  "HALT_FAILED",
  "RECONCILIATION_REQUIRED",
]);

const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXPERIMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const HALT_RECORD_KEYS = [
  "acknowledgement",
  "experimentId",
  "flatnessProven",
  "haltId",
  "haltReasons",
  "highWaterEquityUsd",
  "incidentGeneration",
  "lastRiskEvaluationAt",
  "leaseEnvelopeSha256",
  "leaseGeneration",
  "predecessorHaltId",
  "predecessorStatus",
  "schemaVersion",
  "scopeKey",
  "snapshotFresh",
  "snapshotObservedAt",
  "startingEquityUsd",
  "status",
  "unresolvedPossibleExposure",
  "updatedAt",
] as const;

const ACK_KEYS = [
  "acknowledgedHaltId",
  "currentLeaseGeneration",
  "newStoreGeneration",
  "predecessorEnvelopeSha256",
  "predecessorStoreGeneration",
  "priorLeaseGeneration",
  "resultingStatus",
  "snapshotLeaseGeneration",
  "snapshotObservedAt",
  "snapshotSourceId",
] as const;

export function isHaltStatus(value: unknown): value is HaltStatus {
  return typeof value === "string" && HALT_STATUSES.has(value as HaltStatus);
}

export function isTerminalHaltStatus(status: HaltStatus): boolean {
  return (
    status === "HALTED_FLAT" ||
    status === "HALTED_UNFLAT" ||
    status === "HALT_FAILED" ||
    status === "RECONCILIATION_REQUIRED"
  );
}

export function isNonRunningHaltStatus(status: HaltStatus): boolean {
  return status !== "RUNNING";
}

export function parseHaltRecord(
  payload: unknown,
): { ok: true; record: DurableHaltRecord } | { ok: false; reasonCodes: string[] } {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== HALT_RECORD_KEYS.length ||
    keys.some((key, index) => key !== HALT_RECORD_KEYS[index])
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (record.schemaVersion !== HALT_RECORD_SCHEMA_VERSION) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.scopeKey !== "string") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.experimentId !== "string" || !EXPERIMENT_ID_PATTERN.test(record.experimentId)) {
    return { ok: false, reasonCodes: ["INVALID_EXPERIMENT_ID"] };
  }
  if (!isHaltStatus(record.status)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_STATUS"] };
  }
  const haltId = parseNullableHaltId(record.haltId);
  if (!haltId.ok) {
    return { ok: false, reasonCodes: haltId.reasonCodes };
  }
  const predecessorHaltId = parseNullableHaltId(record.predecessorHaltId);
  if (!predecessorHaltId.ok) {
    return { ok: false, reasonCodes: predecessorHaltId.reasonCodes };
  }
  if (record.predecessorStatus !== null && !isHaltStatus(record.predecessorStatus)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_STATUS"] };
  }
  if (!Array.isArray(record.haltReasons) || record.haltReasons.length > 64) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  for (const reason of record.haltReasons) {
    if (typeof reason !== "string" || !REASON_PATTERN.test(reason)) {
      return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
    }
  }
  if (
    typeof record.incidentGeneration !== "string" ||
    !isCanonicalGenerationString(record.incidentGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  const leaseGeneration = parseNullableGeneration(record.leaseGeneration);
  if (!leaseGeneration.ok) {
    return { ok: false, reasonCodes: leaseGeneration.reasonCodes };
  }
  const leaseEnvelopeSha256 = parseNullableSha256(record.leaseEnvelopeSha256);
  if (!leaseEnvelopeSha256.ok) {
    return { ok: false, reasonCodes: leaseEnvelopeSha256.reasonCodes };
  }
  if (typeof record.unresolvedPossibleExposure !== "boolean") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.flatnessProven !== "boolean") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.snapshotFresh !== "boolean") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (record.snapshotObservedAt !== null && typeof record.snapshotObservedAt !== "string") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  const startingEquityUsd = parseNullableDecimal(record.startingEquityUsd);
  if (!startingEquityUsd.ok) {
    return { ok: false, reasonCodes: startingEquityUsd.reasonCodes };
  }
  const highWaterEquityUsd = parseNullableDecimal(record.highWaterEquityUsd);
  if (!highWaterEquityUsd.ok) {
    return { ok: false, reasonCodes: highWaterEquityUsd.reasonCodes };
  }
  if (record.lastRiskEvaluationAt !== null && typeof record.lastRiskEvaluationAt !== "string") {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.updatedAt !== "string" || !ISO_UTC_PATTERN.test(record.updatedAt)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  const acknowledgement = parseAcknowledgement(record.acknowledgement);
  if (!acknowledgement.ok) {
    return { ok: false, reasonCodes: acknowledgement.reasonCodes };
  }
  if (record.status !== "RUNNING" && haltId.value === null) {
    return { ok: false, reasonCodes: ["INVALID_HALT_ID"] };
  }
  return {
    ok: true,
    record: {
      schemaVersion: 1,
      scopeKey: record.scopeKey,
      experimentId: record.experimentId,
      haltId: haltId.value,
      haltReasons: [...record.haltReasons],
      status: record.status,
      leaseGeneration: leaseGeneration.value,
      leaseEnvelopeSha256: leaseEnvelopeSha256.value,
      predecessorHaltId: predecessorHaltId.value,
      predecessorStatus: record.predecessorStatus,
      incidentGeneration: record.incidentGeneration,
      acknowledgement: acknowledgement.value,
      unresolvedPossibleExposure: record.unresolvedPossibleExposure,
      flatnessProven: record.flatnessProven,
      snapshotFresh: record.snapshotFresh,
      snapshotObservedAt: record.snapshotObservedAt,
      startingEquityUsd: startingEquityUsd.value,
      highWaterEquityUsd: highWaterEquityUsd.value,
      lastRiskEvaluationAt: record.lastRiskEvaluationAt,
      updatedAt: record.updatedAt,
    },
  };
}

export function makeHaltRecord(
  record: Omit<DurableHaltRecord, "schemaVersion">,
): DurableHaltRecord {
  return {
    schemaVersion: 1,
    scopeKey: record.scopeKey,
    experimentId: record.experimentId,
    haltId: record.haltId,
    haltReasons: [...record.haltReasons],
    status: record.status,
    leaseGeneration: record.leaseGeneration,
    leaseEnvelopeSha256: record.leaseEnvelopeSha256,
    predecessorHaltId: record.predecessorHaltId,
    predecessorStatus: record.predecessorStatus,
    incidentGeneration: record.incidentGeneration,
    acknowledgement: record.acknowledgement === null ? null : { ...record.acknowledgement },
    unresolvedPossibleExposure: record.unresolvedPossibleExposure,
    flatnessProven: record.flatnessProven,
    snapshotFresh: record.snapshotFresh,
    snapshotObservedAt: record.snapshotObservedAt,
    startingEquityUsd: record.startingEquityUsd,
    highWaterEquityUsd: record.highWaterEquityUsd,
    lastRiskEvaluationAt: record.lastRiskEvaluationAt,
    updatedAt: record.updatedAt,
  };
}

function parseAcknowledgement(
  value: unknown,
): { ok: true; value: HaltAcknowledgementLineage | null } | { ok: false; reasonCodes: string[] } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== ACK_KEYS.length || keys.some((key, index) => key !== ACK_KEYS[index])) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.acknowledgedHaltId !== "string" ||
    !isWellFormedHaltId(record.acknowledgedHaltId)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_ID"] };
  }
  if (
    typeof record.predecessorStoreGeneration !== "string" ||
    !isCanonicalGenerationString(record.predecessorStoreGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.predecessorEnvelopeSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(record.predecessorEnvelopeSha256)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.newStoreGeneration !== "string" ||
    !isCanonicalGenerationString(record.newStoreGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.priorLeaseGeneration !== "string" ||
    !isCanonicalGenerationString(record.priorLeaseGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.currentLeaseGeneration !== "string" ||
    !isCanonicalGenerationString(record.currentLeaseGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (!isHaltStatus(record.resultingStatus)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_STATUS"] };
  }
  if (typeof record.snapshotSourceId !== "string" || record.snapshotSourceId.length === 0) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (typeof record.snapshotObservedAt !== "string" || record.snapshotObservedAt.length === 0) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  if (
    typeof record.snapshotLeaseGeneration !== "string" ||
    !isCanonicalGenerationString(record.snapshotLeaseGeneration)
  ) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  return {
    ok: true,
    value: {
      acknowledgedHaltId: record.acknowledgedHaltId,
      predecessorStoreGeneration: record.predecessorStoreGeneration,
      predecessorEnvelopeSha256: record.predecessorEnvelopeSha256,
      newStoreGeneration: record.newStoreGeneration,
      priorLeaseGeneration: record.priorLeaseGeneration,
      currentLeaseGeneration: record.currentLeaseGeneration,
      resultingStatus: record.resultingStatus,
      snapshotSourceId: record.snapshotSourceId,
      snapshotObservedAt: record.snapshotObservedAt,
      snapshotLeaseGeneration: record.snapshotLeaseGeneration,
    },
  };
}

function parseNullableHaltId(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; reasonCodes: string[] } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !isWellFormedHaltId(value)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_ID"] };
  }
  return { ok: true, value };
}

function parseNullableGeneration(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; reasonCodes: string[] } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !isCanonicalGenerationString(value)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  return { ok: true, value };
}

function parseNullableSha256(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; reasonCodes: string[] } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  return { ok: true, value };
}

function parseNullableDecimal(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; reasonCodes: string[] } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string" || !isCanonicalDecimalString(value)) {
    return { ok: false, reasonCodes: ["INVALID_HALT_RECORD"] };
  }
  return { ok: true, value };
}
