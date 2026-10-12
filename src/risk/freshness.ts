import { isCanonicalDecimalString } from "../math/decimal.js";
import type { RiskFreshness } from "./risk-types.js";

const TIMESTAMP_PATTERN = /^(0|[1-9][0-9]{0,12})$/;

export function freshnessFailures(freshness: RiskFreshness): string[] {
  const codes: string[] = [];
  if (
    !TIMESTAMP_PATTERN.test(freshness.evaluatedAt) ||
    !isCanonicalIntegerMs(freshness.maxStaleMs)
  ) {
    return ["STALE_OR_MISSING_INPUT", "INVALID_DECIMAL"];
  }
  const now = BigInt(freshness.evaluatedAt);
  const maxStale = BigInt(freshness.maxStaleMs);
  const fields = [
    freshness.positionObservedAt,
    freshness.equityObservedAt,
    freshness.markObservedAt,
    freshness.pnlObservedAt,
  ];
  for (const observedAt of fields) {
    if (observedAt === null || !TIMESTAMP_PATTERN.test(observedAt)) {
      codes.push("STALE_OR_MISSING_INPUT");
      continue;
    }
    const observed = BigInt(observedAt);
    if (now < observed || now - observed > maxStale) {
      codes.push("STALE_OR_MISSING_INPUT");
    }
  }
  return [...new Set(codes)];
}

function isCanonicalIntegerMs(value: string): boolean {
  return TIMESTAMP_PATTERN.test(value) && isCanonicalDecimalString(value);
}
