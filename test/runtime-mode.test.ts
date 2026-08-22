import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_RUNTIME_MODE, resolveRuntimeMode } from "../src/runtime-mode.js";

test("defaults to dry-run when no runtime mode is configured", () => {
  assert.equal(resolveRuntimeMode(undefined), DEFAULT_RUNTIME_MODE);
  assert.equal(DEFAULT_RUNTIME_MODE, "dry-run");
});

test("accepts an explicit dry-run mode", () => {
  assert.equal(resolveRuntimeMode("dry-run"), "dry-run");
});

test("rejects live and all other unsupported modes", () => {
  assert.throws(
    () => resolveRuntimeMode("live"),
    /Phase 0 permits dry-run only; live mode is unavailable/,
  );
  assert.throws(() => resolveRuntimeMode("paper"), /Unsupported runtime mode/);
});
