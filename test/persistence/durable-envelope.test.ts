import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CanonicalJsonError,
  canonicalSerializeToUtf8,
} from "../../src/persistence/canonical-json.js";
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

test("C9 stateful getter cannot make buildDurableEnvelope return inconsistent bytes", () => {
  let getterCalls = 0;
  const payload = {
    get marker() {
      getterCalls += 1;
      return getterCalls === 1 ? "first" : "second";
    },
    levels: 10,
    notionalUsd: "100",
  };
  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      payload,
    });
    assert.fail("expected accessor rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "ACCESSOR_PROPERTY");
  }
  assert.equal(getterCalls, 0);
});

test("C10 buildDurableEnvelope observes a normal payload once and uses a detached snapshot", () => {
  const payload = {
    levels: 10,
    marker: "phase2a-canonical-vector",
    notionalUsd: "100",
  };
  let ownKeysCalls = 0;
  let descriptorCalls = 0;
  const proxied = new Proxy(payload, {
    ownKeys(target) {
      ownKeysCalls += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      descriptorCalls += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const built = buildDurableEnvelope({
    ...fixtureFields(),
    payload: proxied,
  });
  assert.equal(ownKeysCalls, 1);
  assert.equal(descriptorCalls, 3);
  assert.notEqual(built.envelope.payload, proxied);
  assert.deepEqual(built.envelope.payload, payload);
});

test("C11 mutating the original payload after build does not alter returned envelope data", () => {
  const payload = {
    levels: 10,
    marker: "phase2a-canonical-vector",
    notionalUsd: "100",
    nested: { inner: 1 },
  };
  const built = buildDurableEnvelope({
    ...fixtureFields(),
    payload,
  });
  const payloadSha256 = built.envelope.payloadSha256;
  const envelopeSha256 = built.envelope.envelopeSha256;
  const fullBytes = Buffer.from(built.fullEnvelopeBytes);
  payload.levels = 99;
  payload.nested.inner = 99;
  payload.marker = "mutated";
  assert.equal(built.envelope.payload.levels, 10);
  assert.equal(built.envelope.payload.nested.inner, 1);
  assert.equal(built.envelope.payload.marker, "phase2a-canonical-vector");
  assert.equal(built.envelope.payloadSha256, payloadSha256);
  assert.equal(built.envelope.envelopeSha256, envelopeSha256);
  assert.deepEqual(built.fullEnvelopeBytes, fullBytes);
});

test("C12 returned fullEnvelopeBytes always pass parseAndValidateDurableEnvelope", () => {
  const built = buildDurableEnvelope(fixtureFields());
  const result = parseAndValidateDurableEnvelope(built.fullEnvelopeBytes);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.envelope.envelopeSha256, built.envelope.envelopeSha256);
    assert.deepEqual(result.canonicalBytes, built.fullEnvelopeBytes);
  }
});

test("C13 returned payload is not reference-equal to the caller payload or nested objects", () => {
  const nested = { inner: 1 };
  const payload = {
    levels: 10,
    marker: "phase2a-canonical-vector",
    notionalUsd: "100",
    nested,
  };
  const built = buildDurableEnvelope({
    ...fixtureFields(),
    payload,
  });
  assert.notEqual(built.envelope.payload, payload);
  assert.notEqual(built.envelope.payload.nested, nested);
  assert.deepEqual(built.envelope.payload.nested, { inner: 1 });
});

test("C14 malformed runtime scalar field types fail with stable validation codes", () => {
  const cases: Array<{ override: Record<string, unknown>; reasonCode: string }> = [
    { override: { schemaVersion: "1" }, reasonCode: "UNSUPPORTED_SCHEMA" },
    {
      override: {
        kind: {
          toString() {
            return "risk-state";
          },
        },
      },
      reasonCode: "INVALID_KIND",
    },
    { override: { scopeKey: 123 }, reasonCode: "INVALID_SCOPE" },
    { override: { storeGeneration: 1 }, reasonCode: "INVALID_GENERATION" },
    { override: { previousEnvelopeSha256: 0 }, reasonCode: "INVALID_PREVIOUS_HASH" },
  ];
  for (const testCase of cases) {
    try {
      buildDurableEnvelope({
        ...fixtureFields(),
        ...testCase.override,
      } as unknown as ReturnType<typeof fixtureFields>);
      assert.fail(`expected ${testCase.reasonCode}`);
    } catch (error) {
      assert.ok(error instanceof EnvelopeValidationError);
      assert.equal(error.reasonCode, testCase.reasonCode);
    }
  }
});

test("C15 existing literal canonical vectors remain exact", () => {
  const built = buildDurableEnvelope(fixtureFields());
  assert.equal(built.payloadCanonicalBytes.toString("utf8"), CANONICAL_PAYLOAD_BYTES);
  assert.equal(built.envelope.payloadSha256, PAYLOAD_SHA256);
  assert.equal(built.envelopeHashInputBytes.toString("utf8"), CANONICAL_ENVELOPE_HASH_INPUT_BYTES);
  assert.equal(built.envelope.envelopeSha256, ENVELOPE_SHA256);
  assert.equal(built.fullEnvelopeBytes.toString("utf8"), FULL_ENVELOPE_BYTES);
});
