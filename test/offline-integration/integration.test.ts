import assert from "node:assert/strict";
import test from "node:test";
import {
  ackAuthority,
  ambiguousOutcome,
  canonicalHash,
  duplicateEffects,
  fenced,
  freshProcessHalt,
  normalProgression,
  staleInput,
  unresolvedExposure,
} from "./scenarios.js";

test("offline normal grid/risk/execution/persist/reload/reconciliation", async () => {
  await normalProgression();
});
test("duplicate observation, intent and execution have one economic effect", duplicateEffects);
test("ambiguous write remains unresolved after reload", ambiguousOutcome);
test("stale market and risk observations fail closed", staleInput);
test("process fence blocks risk-increasing submission", () => fenced("process"));
test("expired lease blocks fake adapter callback", () => fenced("expired"));
test("mismatched lease blocks fake adapter callback", () => fenced("mismatched"));
test("persistence uncertainty blocks risk increase", () => fenced("persistence"));
test("unresolved durable exposure blocks CONTINUE", unresolvedExposure);
test("HALT survives fresh process and requires durable current ACK", freshProcessHalt);
test("wrong ID and stale authority cannot ACK; safe exact pair can", ackAuthority);
test("replay produces identical canonical final state hash", async () => {
  assert.equal(await normalProgression(), await normalProgression());
});
test("canonical evidence hash changes when economic state changes", () => {
  assert.notEqual(canonicalHash({ quantity: "0.004" }), canonicalHash({ quantity: "0.005" }));
});
