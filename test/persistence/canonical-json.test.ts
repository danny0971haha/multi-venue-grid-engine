import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CanonicalJsonError,
  canonicalSerialize,
  canonicalSerializeToUtf8,
} from "../../src/persistence/canonical-json.js";
import {
  CANONICAL_PAYLOAD_BYTES,
  FIXTURE_PAYLOAD,
  PAYLOAD_SHA256,
} from "../fixtures/phase2a-canonical-vector.js";

function sha256Utf8(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

test("2A-C01 different input object key order yields identical canonical bytes and hash", () => {
  const left = { z: 2, a: 1, m: { y: 4, b: 3 } };
  const right = { a: 1, m: { b: 3, y: 4 }, z: 2 };
  const leftBytes = canonicalSerializeToUtf8(left);
  const rightBytes = canonicalSerializeToUtf8(right);
  assert.equal(leftBytes, '{"a":1,"m":{"b":3,"y":4},"z":2}');
  assert.equal(rightBytes, leftBytes);
  assert.equal(sha256Utf8(leftBytes), sha256Utf8(rightBytes));
});

test("canonical payload fixture bytes and hash are frozen literals", () => {
  const bytes = canonicalSerializeToUtf8({
    marker: FIXTURE_PAYLOAD.marker,
    notionalUsd: FIXTURE_PAYLOAD.notionalUsd,
    levels: FIXTURE_PAYLOAD.levels,
  });
  assert.equal(bytes, CANONICAL_PAYLOAD_BYTES);
  assert.equal(sha256Utf8(bytes), PAYLOAD_SHA256);
  assert.equal(CANONICAL_PAYLOAD_BYTES.includes("\n"), false);
  assert.equal(CANONICAL_PAYLOAD_BYTES.startsWith("\uFEFF"), false);
});

test("canonicalization does not mutate caller-owned objects", () => {
  const payload = {
    z: 1,
    a: { y: 2, b: 3 },
  };
  const keyOrderBefore = [...Object.keys(payload), ...Object.keys(payload.a)];
  canonicalSerialize(payload);
  assert.deepEqual(Object.keys(payload), ["z", "a"]);
  assert.deepEqual(Object.keys(payload.a), ["y", "b"]);
  assert.deepEqual([...Object.keys(payload), ...Object.keys(payload.a)], keyOrderBefore);
});

test("2A-C09 unsafe integer is rejected", () => {
  assert.throws(() => canonicalSerialize({ n: Number.MAX_SAFE_INTEGER + 1 }), CanonicalJsonError);
  try {
    canonicalSerialize({ n: 9007199254740992 });
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "UNSAFE_INTEGER");
  }
});

test("2A-C10 negative zero is rejected", () => {
  try {
    canonicalSerialize({ n: -0 });
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "NEGATIVE_ZERO");
  }
});

test("2A-C11 dangerous prototype key is rejected", () => {
  for (const key of ["__proto__", "prototype", "constructor"]) {
    try {
      canonicalSerialize({ [key]: 1, safe: true });
      assert.fail(`expected rejection for ${key}`);
    } catch (error) {
      assert.ok(error instanceof CanonicalJsonError);
      assert.equal(error.reasonCode, "DANGEROUS_OBJECT_KEY");
    }
  }
});

test("2A-C12 sparse array and non-plain object are rejected", () => {
  const sparse: unknown[] = [];
  sparse[1] = 1;
  try {
    canonicalSerialize(sparse);
    assert.fail("expected sparse rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "SPARSE_ARRAY");
  }

  try {
    canonicalSerialize(new Date("2026-01-01T00:00:00.000Z"));
    assert.fail("expected Date rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "NON_PLAIN_OBJECT");
  }

  try {
    canonicalSerialize(new Map([["a", 1]]));
    assert.fail("expected Map rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "NON_PLAIN_OBJECT");
  }

  class Example {
    value = 1;
  }
  try {
    canonicalSerialize(new Example());
    assert.fail("expected class instance rejection");
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, "NON_PLAIN_OBJECT");
  }
});

test("serializer rejects undefined, function, symbol, bigint, NaN, Infinity, and cycles", () => {
  assert.throws(() => canonicalSerialize({ a: undefined }), CanonicalJsonError);
  assert.throws(() => canonicalSerialize({ a: () => 1 }), CanonicalJsonError);
  assert.throws(() => canonicalSerialize({ a: Symbol("x") }), CanonicalJsonError);
  assert.throws(() => canonicalSerialize({ a: 1n }), CanonicalJsonError);
  assert.throws(() => canonicalSerialize({ a: Number.NaN }), CanonicalJsonError);
  assert.throws(() => canonicalSerialize({ a: Number.POSITIVE_INFINITY }), CanonicalJsonError);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalSerialize(cyclic), CanonicalJsonError);
});

test("string content is preserved without Unicode normalization", () => {
  const combining = "e\u0301";
  const composed = "\u00e9";
  assert.notEqual(combining, composed);
  assert.equal(canonicalSerializeToUtf8(combining), JSON.stringify(combining));
  assert.equal(canonicalSerializeToUtf8(composed), JSON.stringify(composed));
  assert.notEqual(canonicalSerializeToUtf8(combining), canonicalSerializeToUtf8(composed));
});

test("safe integer metadata numbers are emitted without exponent or trailing newline", () => {
  const bytes = canonicalSerializeToUtf8({ schemaVersion: 1, count: 0 });
  assert.equal(bytes, '{"count":0,"schemaVersion":1}');
  assert.equal(bytes.endsWith("\n"), false);
});

function assertCanonicalCode(value: unknown, reasonCode: string): void {
  try {
    canonicalSerialize(value);
    assert.fail(`expected ${reasonCode}`);
  } catch (error) {
    assert.ok(error instanceof CanonicalJsonError);
    assert.equal(error.reasonCode, reasonCode);
  }
}

test("C1 array with Symbol own property is rejected", () => {
  const value = [1, 2];
  Object.defineProperty(value, Symbol("hidden"), { value: "meta" });
  assertCanonicalCode(value, "SYMBOL_VALUE");
});

test("C2 array with non-enumerable hidden own property is rejected", () => {
  const value = [1, 2];
  Object.defineProperty(value, "hidden", { value: "meta", enumerable: false });
  assertCanonicalCode(value, "EXTRA_ARRAY_PROPERTY");
});

test("C3 array with enumerable extra string property is rejected", () => {
  const value = [1, 2];
  Object.defineProperty(value, "extra", { value: "meta", enumerable: true });
  assertCanonicalCode(value, "EXTRA_ARRAY_PROPERTY");
});

test("C4 array index getter is rejected and getter is not invoked", () => {
  let getterCalls = 0;
  const value: unknown[] = [];
  Object.defineProperty(value, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("array index getter invoked");
    },
  });
  assertCanonicalCode(value, "ACCESSOR_PROPERTY");
  assert.equal(getterCalls, 0);
});

test("C5 enumerable object getter is rejected and getter is not invoked", () => {
  let getterCalls = 0;
  const value = {
    get marker() {
      getterCalls += 1;
      throw new Error("object getter invoked");
    },
  };
  assertCanonicalCode(value, "ACCESSOR_PROPERTY");
  assert.equal(getterCalls, 0);
});

test("C6 object setter-only accessor descriptor is rejected", () => {
  const value = {};
  Object.defineProperty(value, "marker", {
    enumerable: true,
    configurable: true,
    set() {
      throw new Error("object setter invoked");
    },
  });
  assertCanonicalCode(value, "ACCESSOR_PROPERTY");
});

test("C7 non-enumerable object data property is rejected", () => {
  const value = { visible: 1 };
  Object.defineProperty(value, "hidden", { value: 2, enumerable: false });
  assertCanonicalCode(value, "NON_ENUMERABLE_PROPERTY");
});

test("C8 nested accessor is rejected without invocation", () => {
  let getterCalls = 0;
  const value = {
    nested: {
      get inner() {
        getterCalls += 1;
        throw new Error("nested getter invoked");
      },
    },
  };
  assertCanonicalCode(value, "ACCESSOR_PROPERTY");
  assert.equal(getterCalls, 0);
});
