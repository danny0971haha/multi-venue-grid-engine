/**
 * Frozen Phase 2A canonical vectors.
 * Values are asserted literally so later serialization changes cannot pass silently.
 */
export const FIXTURE_KIND = "risk-state";
export const FIXTURE_SCOPE_KEY = "acct/venue/market/grid";
export const FIXTURE_SCHEMA_VERSION = 1;
export const FIXTURE_GENERATION = "1";

export const FIXTURE_PAYLOAD = {
  levels: 10,
  marker: "phase2a-canonical-vector",
  notionalUsd: "100",
} as const;

export const CANONICAL_PAYLOAD_BYTES =
  '{"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"}';

export const PAYLOAD_SHA256 = "1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2";

export const CANONICAL_ENVELOPE_HASH_INPUT_BYTES =
  '{"kind":"risk-state","payload":{"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"},"payloadSha256":"1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2","previousEnvelopeSha256":null,"schemaVersion":1,"scopeKey":"acct/venue/market/grid","storeGeneration":"1"}';

export const ENVELOPE_SHA256 = "0cab9a0f0be80d3aba5ceb1d01d26d568af8bfedfc50f3f17dda3ebbd47e71d2";

export const FULL_ENVELOPE_BYTES =
  '{"envelopeSha256":"0cab9a0f0be80d3aba5ceb1d01d26d568af8bfedfc50f3f17dda3ebbd47e71d2","kind":"risk-state","payload":{"levels":10,"marker":"phase2a-canonical-vector","notionalUsd":"100"},"payloadSha256":"1e0e100c04353644249d0ce2e438b2401a91c21155943635ffd63422f6d382c2","previousEnvelopeSha256":null,"schemaVersion":1,"scopeKey":"acct/venue/market/grid","storeGeneration":"1"}';

export const FIXTURE_SECRET_LIKE = "phase2a-local-fixture-not-a-credential";
