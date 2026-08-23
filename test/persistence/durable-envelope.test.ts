import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalSerializeToUtf8 } from "../../src/persistence/canonical-json.js";
import {
  buildDurableEnvelope,
  EnvelopeValidationError,
  parseAndValidateDurableEnvelope,
} from "../../src/persistence/durable-envelope.js";
import {
  CANONICAL_ENVELOPE_HASH_INPUT_BYTES,
  CANONICAL_PAYLOAD_BYTES,
  ENVELOPE_SHA256,
  FIXTURE_GENERATION,
  FIXTURE_KIND,
  FIXTURE_PAYLOAD,
  FIXTURE_SCHEMA_VERSION,
  FIXTURE_SCOPE_KEY,
  FULL_ENVELOPE_BYTES,
  PAYLOAD_SHA256,
} from "../fixtures/phase2a-canonical-vector.js";

function fixtureFields() {
  return {
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    kind: FIXTURE_KIND,
    scopeKey: FIXTURE_SCOPE_KEY,
    storeGeneration: FIXTURE_GENERATION,
    previousEnvelopeSha256: null,
    payload: {
      levels: FIXTURE_PAYLOAD.levels,
      marker: FIXTURE_PAYLOAD.marker,
      notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    },
  };
}

test("frozen canonical envelope vectors are asserted literally", () => {
  const built = buildDurableEnvelope(fixtureFields());
  assert.equal(built.payloadCanonicalBytes.toString("utf8"), CANONICAL_PAYLOAD_BYTES);
  assert.equal(built.envelope.payloadSha256, PAYLOAD_SHA256);
  assert.equal(built.envelopeHashInputBytes.toString("utf8"), CANONICAL_ENVELOPE_HASH_INPUT_BYTES);
  assert.equal(built.envelope.envelopeSha256, ENVELOPE_SHA256);
  assert.equal(built.fullEnvelopeBytes.toString("utf8"), FULL_ENVELOPE_BYTES);
  assert.equal(FULL_ENVELOPE_BYTES.includes("\n"), false);
  assert.equal(FULL_ENVELOPE_BYTES.startsWith("\uFEFF"), false);

  const validated = parseAndValidateDurableEnvelope(built.fullEnvelopeBytes);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.equal(validated.envelope.envelopeSha256, ENVELOPE_SHA256);
    assert.equal(validated.canonicalBytes.toString("utf8"), FULL_ENVELOPE_BYTES);
  }
});

test("2A-C02 payload byte mutation fails payload hash", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const mutated = Buffer.from(
    built.fullEnvelopeBytes
      .toString("utf8")
      .replace("phase2a-canonical-vector", "phase2a-mutated-vector"),
    "utf8",
  );
  const result = parseAndValidateDurableEnvelope(mutated);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("PAYLOAD_HASH_MISMATCH"));
  }
});

test("2A-C03 recomputed payload hash with stale envelope hash fails envelope hash", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const parsed = JSON.parse(built.fullEnvelopeBytes.toString("utf8")) as Record<string, unknown>;
  parsed.payload = { levels: 11, marker: "phase2a-canonical-vector", notionalUsd: "100" };
  parsed.payloadSha256 = built.envelope.payloadSha256;
  const stale = Buffer.from(canonicalSerializeToUtf8(parsed), "utf8");
  const result = parseAndValidateDurableEnvelope(stale);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("PAYLOAD_HASH_MISMATCH"));
  }

  const payloadBytes = canonicalSerializeToUtf8(parsed.payload);
  parsed.payloadSha256 = createHash("sha256").update(payloadBytes, "utf8").digest("hex");
  const staleEnvelope = Buffer.from(canonicalSerializeToUtf8(parsed), "utf8");
  const envelopeResult = parseAndValidateDurableEnvelope(staleEnvelope);
  assert.equal(envelopeResult.ok, false);
  if (!envelopeResult.ok) {
    assert.ok(envelopeResult.reasonCodes.includes("ENVELOPE_HASH_MISMATCH"));
  }
});

test("2A-C04 duplicate raw JSON keys are rejected as non-canonical", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const raw = built.fullEnvelopeBytes.toString("utf8");
  const duplicated = raw.replace('"kind":"risk-state"', '"kind":"risk-state","kind":"risk-state"');
  const result = parseAndValidateDurableEnvelope(Buffer.from(duplicated, "utf8"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("NON_CANONICAL_BYTES"));
  }
});

test("2A-C05 whitespace variant is rejected", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const spaced = built.fullEnvelopeBytes.toString("utf8").replace(":", ": ");
  const result = parseAndValidateDurableEnvelope(Buffer.from(spaced, "utf8"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("NON_CANONICAL_BYTES"));
  }
});

test("2A-C06 trailing newline is rejected", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const result = parseAndValidateDurableEnvelope(
    Buffer.concat([built.fullEnvelopeBytes, Buffer.from("\n", "utf8")]),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("NON_CANONICAL_BYTES"));
  }
});

test("2A-C07 UTF-8 BOM is rejected", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), built.fullEnvelopeBytes]);
  const result = parseAndValidateDurableEnvelope(bom);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("NON_CANONICAL_BYTES"));
  }
});

test("2A-C08 unknown top-level field is rejected", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const parsed = JSON.parse(built.fullEnvelopeBytes.toString("utf8")) as Record<string, unknown>;
  parsed.extra = true;
  const result = parseAndValidateDurableEnvelope(
    Buffer.from(canonicalSerializeToUtf8(parsed), "utf8"),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("UNKNOWN_TOP_LEVEL_FIELD"));
  }
});

test("2A-C13 generation 1 with non-null previous hash is rejected", () => {
  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      previousEnvelopeSha256: "a".repeat(64),
    });
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof EnvelopeValidationError);
    assert.match(String(error), /INVALID_PREVIOUS_HASH/);
  }
});

test("2A-C14 generation greater than 1 with null or invalid previous hash is rejected", () => {
  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      storeGeneration: "2",
      previousEnvelopeSha256: null,
    });
    assert.fail("expected null previous rejection");
  } catch (error) {
    assert.match(String(error), /INVALID_PREVIOUS_HASH/);
  }

  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      storeGeneration: "2",
      previousEnvelopeSha256: "ABC",
    });
    assert.fail("expected invalid previous rejection");
  } catch (error) {
    assert.match(String(error), /INVALID_PREVIOUS_HASH/);
  }
});

test("generation is not accepted as a JavaScript number", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const parsed = JSON.parse(built.fullEnvelopeBytes.toString("utf8")) as Record<string, unknown>;
  parsed.storeGeneration = 1;
  const result = parseAndValidateDurableEnvelope(
    Buffer.from(canonicalSerializeToUtf8(parsed), "utf8"),
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.reasonCodes.includes("INVALID_GENERATION"));
  }
});
