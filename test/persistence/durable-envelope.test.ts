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

const DOCUMENTED_FIELD_OBSERVATIONS = {
  schemaVersion: 1,
  kind: 1,
  scopeKey: 1,
  storeGeneration: 1,
  previousEnvelopeSha256: 1,
  payload: 1,
} as const;

type EnvelopeBuildInput = {
  schemaVersion: number;
  kind: string;
  scopeKey: string;
  storeGeneration: string;
  previousEnvelopeSha256: string | null;
  payload: Record<string, unknown>;
};
type BuiltEnvelope = ReturnType<typeof buildDurableEnvelope>;

function assertSuccessfulBuildSelfValidates(built: BuiltEnvelope): void {
  const result = parseAndValidateDurableEnvelope(built.fullEnvelopeBytes);
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepEqual(result.canonicalBytes, built.fullEnvelopeBytes);
  assert.equal(result.envelope.schemaVersion, built.envelope.schemaVersion);
  assert.equal(result.envelope.kind, built.envelope.kind);
  assert.equal(result.envelope.scopeKey, built.envelope.scopeKey);
  assert.equal(result.envelope.storeGeneration, built.envelope.storeGeneration);
  assert.equal(result.envelope.previousEnvelopeSha256, built.envelope.previousEnvelopeSha256);
  assert.equal(result.envelope.payloadSha256, built.envelope.payloadSha256);
  assert.equal(result.envelope.envelopeSha256, built.envelope.envelopeSha256);
}

function assertHashInputMatchesReturnedEnvelope(built: BuiltEnvelope): void {
  const hashInput = JSON.parse(built.envelopeHashInputBytes.toString("utf8")) as {
    schemaVersion: unknown;
    kind: unknown;
    scopeKey: unknown;
    storeGeneration: unknown;
    previousEnvelopeSha256: unknown;
    payloadSha256: unknown;
    payload: unknown;
  };
  assert.equal(hashInput.schemaVersion, built.envelope.schemaVersion);
  assert.equal(hashInput.kind, built.envelope.kind);
  assert.equal(hashInput.scopeKey, built.envelope.scopeKey);
  assert.equal(hashInput.storeGeneration, built.envelope.storeGeneration);
  assert.deepEqual(hashInput.previousEnvelopeSha256, built.envelope.previousEnvelopeSha256);
  assert.equal(hashInput.payloadSha256, built.envelope.payloadSha256);
  assert.deepEqual(hashInput.payload, built.envelope.payload);
}

function assertRecomputedEnvelopeSha256(built: BuiltEnvelope): void {
  const minusHash = {
    schemaVersion: built.envelope.schemaVersion,
    kind: built.envelope.kind,
    scopeKey: built.envelope.scopeKey,
    storeGeneration: built.envelope.storeGeneration,
    previousEnvelopeSha256: built.envelope.previousEnvelopeSha256,
    payloadSha256: built.envelope.payloadSha256,
    payload: built.envelope.payload,
  };
  const recomputed = createHash("sha256")
    .update(canonicalSerializeToUtf8(minusHash), "utf8")
    .digest("hex");
  assert.equal(recomputed, built.envelope.envelopeSha256);
  assert.equal(canonicalSerializeToUtf8(minusHash), built.envelopeHashInputBytes.toString("utf8"));
}

function fieldsWithStatefulGetter<K extends keyof EnvelopeBuildInput>(
  key: K,
  first: EnvelopeBuildInput[K],
  second: EnvelopeBuildInput[K],
): { fields: EnvelopeBuildInput; calls: () => number } {
  let calls = 0;
  const fields = {
    ...fixtureFields(),
    get [key]() {
      calls += 1;
      return calls === 1 ? first : second;
    },
  } as EnvelopeBuildInput;
  return { fields, calls: () => calls };
}

function countFieldReads(target: EnvelopeBuildInput): {
  proxy: EnvelopeBuildInput;
  counts: Record<keyof typeof DOCUMENTED_FIELD_OBSERVATIONS, number>;
} {
  const counts = {
    schemaVersion: 0,
    kind: 0,
    scopeKey: 0,
    storeGeneration: 0,
    previousEnvelopeSha256: 0,
    payload: 0,
  };
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && Object.hasOwn(counts, prop)) {
        counts[prop as keyof typeof counts] += 1;
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { proxy, counts };
}

function adversarialSuccessfulBuilds(): Array<{ name: string; built: BuiltEnvelope }> {
  const schemaVersionGetter = fieldsWithStatefulGetter("schemaVersion", 1, 99);
  const kindGetter = fieldsWithStatefulGetter("kind", FIXTURE_KIND, "other-kind");
  const scopeKeyGetter = fieldsWithStatefulGetter("scopeKey", FIXTURE_SCOPE_KEY, "other/scope");
  const storeGenerationGetter = fieldsWithStatefulGetter("storeGeneration", "1", "2");
  const previousHashGetter = fieldsWithStatefulGetter(
    "previousEnvelopeSha256",
    null,
    "a".repeat(64),
  );
  const payloadGetter = fieldsWithStatefulGetter(
    "payload",
    {
      levels: 10,
      marker: "first-payload",
      notionalUsd: "100",
    },
    {
      levels: 99,
      marker: "second-payload",
      notionalUsd: "0",
    },
  );
  return [
    { name: "fixture", built: buildDurableEnvelope(fixtureFields()) },
    {
      name: "generation-2",
      built: buildDurableEnvelope({
        ...fixtureFields(),
        storeGeneration: "2",
        previousEnvelopeSha256: "a".repeat(64),
      }),
    },
    {
      name: "nested-payload",
      built: buildDurableEnvelope({
        ...fixtureFields(),
        payload: {
          levels: 10,
          marker: "nested",
          notionalUsd: "100",
          nested: { inner: [1, 2, { k: "v" }] },
        },
      }),
    },
    {
      name: "alt-kind-scope",
      built: buildDurableEnvelope({
        ...fixtureFields(),
        kind: "grid.level:v1",
        scopeKey: "scope/a_b:1",
      }),
    },
    { name: "stateful-schemaVersion", built: buildDurableEnvelope(schemaVersionGetter.fields) },
    { name: "stateful-kind", built: buildDurableEnvelope(kindGetter.fields) },
    { name: "stateful-scopeKey", built: buildDurableEnvelope(scopeKeyGetter.fields) },
    { name: "stateful-storeGeneration", built: buildDurableEnvelope(storeGenerationGetter.fields) },
    {
      name: "stateful-previousEnvelopeSha256",
      built: buildDurableEnvelope(previousHashGetter.fields),
    },
    { name: "stateful-payload", built: buildDurableEnvelope(payloadGetter.fields) },
  ];
}

test("C2-01 stateful schemaVersion getter cannot produce inconsistent successful output", () => {
  const { fields, calls } = fieldsWithStatefulGetter("schemaVersion", 1, 99);
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.equal(built.envelope.schemaVersion, 1);
  assertSuccessfulBuildSelfValidates(built);
  assertHashInputMatchesReturnedEnvelope(built);
  assertRecomputedEnvelopeSha256(built);
});

test("C2-02 stateful kind getter cannot produce inconsistent successful output", () => {
  const { fields, calls } = fieldsWithStatefulGetter("kind", FIXTURE_KIND, "other-kind");
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.equal(built.envelope.kind, FIXTURE_KIND);
  assertSuccessfulBuildSelfValidates(built);
  assertHashInputMatchesReturnedEnvelope(built);
  assertRecomputedEnvelopeSha256(built);
});

test("C2-03 stateful scopeKey getter cannot produce inconsistent successful output", () => {
  const { fields, calls } = fieldsWithStatefulGetter("scopeKey", FIXTURE_SCOPE_KEY, "other/scope");
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.equal(built.envelope.scopeKey, FIXTURE_SCOPE_KEY);
  assertSuccessfulBuildSelfValidates(built);
  assertHashInputMatchesReturnedEnvelope(built);
  assertRecomputedEnvelopeSha256(built);
});

test("C2-04 stateful storeGeneration getter cannot produce inconsistent successful output", () => {
  const { fields, calls } = fieldsWithStatefulGetter("storeGeneration", "1", "2");
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.equal(built.envelope.storeGeneration, "1");
  assertSuccessfulBuildSelfValidates(built);
  assertHashInputMatchesReturnedEnvelope(built);
  assertRecomputedEnvelopeSha256(built);
});

test("C2-05 stateful previousEnvelopeSha256 getter cannot produce inconsistent output", () => {
  const { fields, calls } = fieldsWithStatefulGetter(
    "previousEnvelopeSha256",
    null,
    "a".repeat(64),
  );
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.equal(built.envelope.previousEnvelopeSha256, null);
  assertSuccessfulBuildSelfValidates(built);
  assertHashInputMatchesReturnedEnvelope(built);
  assertRecomputedEnvelopeSha256(built);
});

test("C2-06 stateful payload getter is observed once or rejected before invocation", () => {
  const firstPayload = {
    levels: 10,
    marker: "observed-once",
    notionalUsd: "100",
  };
  const { fields, calls } = fieldsWithStatefulGetter("payload", firstPayload, {
    levels: 99,
    marker: "second-payload",
    notionalUsd: "0",
  });
  const built = buildDurableEnvelope(fields);
  assert.equal(calls(), 1);
  assert.deepEqual(built.envelope.payload, firstPayload);
  assert.notEqual(built.envelope.payload, firstPayload);
  assertSuccessfulBuildSelfValidates(built);
});

test("C2-07 proxy counters prove each accepted input field is observed no more than the documented number of times", () => {
  const { proxy, counts } = countFieldReads(fixtureFields());
  const built = buildDurableEnvelope(proxy);
  assert.equal(counts.schemaVersion, DOCUMENTED_FIELD_OBSERVATIONS.schemaVersion);
  assert.equal(counts.kind, DOCUMENTED_FIELD_OBSERVATIONS.kind);
  assert.equal(counts.scopeKey, DOCUMENTED_FIELD_OBSERVATIONS.scopeKey);
  assert.equal(counts.storeGeneration, DOCUMENTED_FIELD_OBSERVATIONS.storeGeneration);
  assert.equal(counts.previousEnvelopeSha256, DOCUMENTED_FIELD_OBSERVATIONS.previousEnvelopeSha256);
  assert.equal(counts.payload, DOCUMENTED_FIELD_OBSERVATIONS.payload);
  assertSuccessfulBuildSelfValidates(built);
});

test("C2-08 no getter is invoked merely to format an error diagnostic", () => {
  let kindCalls = 0;
  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      get kind() {
        kindCalls += 1;
        if (kindCalls > 1) {
          throw new Error("kind getter invoked for diagnostic formatting");
        }
        return 123;
      },
    } as unknown as EnvelopeBuildInput);
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof EnvelopeValidationError);
    assert.equal(error.reasonCode, "INVALID_KIND");
    assert.match(String(error), /INVALID_KIND/);
  }
  assert.equal(kindCalls, 1);

  let payloadCalls = 0;
  try {
    buildDurableEnvelope({
      ...fixtureFields(),
      schemaVersion: "1",
      get payload() {
        payloadCalls += 1;
        if (payloadCalls > 1) {
          throw new Error("payload getter invoked for diagnostic formatting");
        }
        return fixtureFields().payload;
      },
    } as unknown as EnvelopeBuildInput);
    assert.fail("expected schema rejection");
  } catch (error) {
    assert.ok(error instanceof EnvelopeValidationError);
    assert.equal(error.reasonCode, "UNSUPPORTED_SCHEMA");
  }
  assert.equal(payloadCalls, 1);
});

test("C2-09 every successful build in the adversarial table self-validates", () => {
  for (const entry of adversarialSuccessfulBuilds()) {
    const result = parseAndValidateDurableEnvelope(entry.built.fullEnvelopeBytes);
    assert.equal(result.ok, true, entry.name);
  }
});

test("C2-10 validated canonicalBytes equal result.fullEnvelopeBytes exactly", () => {
  for (const entry of adversarialSuccessfulBuilds()) {
    const result = parseAndValidateDurableEnvelope(entry.built.fullEnvelopeBytes);
    assert.equal(result.ok, true, entry.name);
    if (result.ok) {
      assert.deepEqual(result.canonicalBytes, entry.built.fullEnvelopeBytes, entry.name);
    }
  }
});

test("C2-11 returned envelope fields equal the scalar values used by the hash input", () => {
  for (const entry of adversarialSuccessfulBuilds()) {
    assertHashInputMatchesReturnedEnvelope(entry.built);
  }
});

test("C2-12 recomputing envelopeSha256 from the returned envelope-minus-hash produces exactly the returned envelopeSha256", () => {
  for (const entry of adversarialSuccessfulBuilds()) {
    assertRecomputedEnvelopeSha256(entry.built);
  }
});

test("C2-13 mutate all caller scalar backing values after build; returned envelope and bytes remain unchanged", () => {
  const backing: EnvelopeBuildInput = fixtureFields();
  const fields = {
    get schemaVersion() {
      return backing.schemaVersion;
    },
    get kind() {
      return backing.kind;
    },
    get scopeKey() {
      return backing.scopeKey;
    },
    get storeGeneration() {
      return backing.storeGeneration;
    },
    get previousEnvelopeSha256() {
      return backing.previousEnvelopeSha256;
    },
    get payload() {
      return backing.payload;
    },
  };
  const built = buildDurableEnvelope(fields);
  const envelopeSha256 = built.envelope.envelopeSha256;
  const payloadSha256 = built.envelope.payloadSha256;
  const fullBytes = Buffer.from(built.fullEnvelopeBytes);
  const hashInputBytes = Buffer.from(built.envelopeHashInputBytes);
  const payloadSnapshot = built.envelope.payload;

  backing.schemaVersion = 99;
  backing.kind = "mutated-kind";
  backing.scopeKey = "mutated/scope";
  backing.storeGeneration = "9";
  backing.previousEnvelopeSha256 = "b".repeat(64);
  backing.payload = { levels: 0, marker: "mutated", notionalUsd: "0" };

  assert.equal(built.envelope.schemaVersion, FIXTURE_SCHEMA_VERSION);
  assert.equal(built.envelope.kind, FIXTURE_KIND);
  assert.equal(built.envelope.scopeKey, FIXTURE_SCOPE_KEY);
  assert.equal(built.envelope.storeGeneration, FIXTURE_GENERATION);
  assert.equal(built.envelope.previousEnvelopeSha256, null);
  assert.deepEqual(built.envelope.payload, payloadSnapshot);
  assert.equal(built.envelope.payloadSha256, payloadSha256);
  assert.equal(built.envelope.envelopeSha256, envelopeSha256);
  assert.deepEqual(built.fullEnvelopeBytes, fullBytes);
  assert.deepEqual(built.envelopeHashInputBytes, hashInputBytes);
});

test("C2-14 mutate nested payload after build; existing detached-snapshot tests remain green", () => {
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
  assertSuccessfulBuildSelfValidates(built);
});

test("C2-15 a getter that changes value on the second call cannot create a successful but internally inconsistent result", () => {
  const cases: Array<{
    key: keyof EnvelopeBuildInput;
    first: EnvelopeBuildInput[keyof EnvelopeBuildInput];
    second: EnvelopeBuildInput[keyof EnvelopeBuildInput];
  }> = [
    { key: "schemaVersion", first: 1, second: 99 },
    { key: "kind", first: FIXTURE_KIND, second: "other-kind" },
    { key: "scopeKey", first: FIXTURE_SCOPE_KEY, second: "other/scope" },
    { key: "storeGeneration", first: "1", second: "2" },
    { key: "previousEnvelopeSha256", first: null, second: "a".repeat(64) },
    {
      key: "payload",
      first: { levels: 10, marker: "first", notionalUsd: "100" },
      second: { levels: 99, marker: "second", notionalUsd: "1" },
    },
  ];
  for (const testCase of cases) {
    const { fields, calls } = fieldsWithStatefulGetter(
      testCase.key,
      testCase.first as never,
      testCase.second as never,
    );
    const built = buildDurableEnvelope(fields);
    assert.equal(calls(), 1, String(testCase.key));
    assertSuccessfulBuildSelfValidates(built);
    assertHashInputMatchesReturnedEnvelope(built);
    assertRecomputedEnvelopeSha256(built);
  }
});
