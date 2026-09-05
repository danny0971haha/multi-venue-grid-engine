import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acknowledgeHalt,
  applyRiskDecision,
  executeHardHalt,
  inspectHaltContinuation,
  loadHaltAuthority,
  makeHaltRecord,
  persistHaltTransition,
} from "../../src/halt/index.js";
import {
  LEASE_TTL_MS,
  canonicalSerialize,
  fixedLeaseClock,
  initializeExactPair,
  inspectExactPair,
  releaseRuntimeLease,
  runLeaseFencedMutation,
} from "../../src/persistence/index.js";
import { evaluateRisk } from "../../src/risk/index.js";
import { DeterministicSimulator } from "../../src/simulator/engine.js";
import {
  HALT_ISO,
  NOW_MS,
  SCOPE_KEY,
  baselineRiskInput,
  seedHaltContext,
  snapshot,
  withTempDir,
} from "../halt/helpers.js";
import { testInit } from "../simulator/helpers.js";

export const FIXTURE = {
  observationId: "market-001",
  observedAt: "1000000",
  anchor: "100",
  executionId: "execution-001",
  executionPrice: "99.4",
  executionQuantity: "0.004",
} as const;

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

function plan(sim: DeterministicSimulator) {
  const result = sim.planEntries();
  assert.equal(result.status, "PLANNED");
  if (result.status !== "PLANNED") throw new Error("FIXTURE_INFEASIBLE");
  const entry = result.intents.find((intent) => intent.logicalLevelId === "B1");
  assert.ok(entry);
  return { entry, intents: result.intents };
}

export async function normalProgression(): Promise<string> {
  let finalHash = "";
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const sim = DeterministicSimulator.create(
      testInit({
        experimentId: context.experimentId,
        anchorPrice: FIXTURE.anchor,
        createdAt: HALT_ISO,
        leaseGeneration: context.leaseAuthority.generation,
      }),
    );
    const { entry, intents } = plan(sim);
    const input = baselineRiskInput({
      proposedBatch: intents.map(({ side, price, quantity, reduceOnly, purpose }) => ({
        side,
        price,
        quantity,
        reduceOnly,
        purpose,
      })),
    });
    const risk = evaluateRisk(input);
    assert.equal(risk.action, "CONTINUE");
    // Preserve frozen Phase 2D metrics-only authority; Phase 2E is checked separately.
    assert.equal(risk.systemAllowRiskIncrease, false);
    const halt = await applyRiskDecision(context, input);
    assert.equal(halt.runtimeDisposition, "RUNNING");
    assert.equal(halt.allowRiskIncrease, true);
    const sent = await runLeaseFencedMutation({
      directory,
      scopeKey: SCOPE_KEY,
      authority: context.leaseAuthority,
      latch: context.latch,
      clock: context.leaseClock,
      mutation: async () => sim.submit(entry.intentId, "ACK"),
    });
    assert.equal(sent.callbackCount, 1);
    assert.equal(sent.value?.kind, "ACK");
    if (sent.value?.kind !== "ACK") throw new Error("SIMULATED_ACK_REQUIRED");
    sim.applyExecution({
      executionId: FIXTURE.executionId,
      exchangeOrderId: sent.value.ack.exchangeOrderId,
      quantity: FIXTURE.executionQuantity,
      price: FIXTURE.executionPrice,
    });
    const economic = sim.exportSnapshot();
    const persisted = await initializeExactPair({
      directory,
      stateName: "integration-simulator",
      expectedKind: "integration-simulator",
      expectedScopeKey: SCOPE_KEY,
      payload: economic,
      bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
      latch: context.latch,
    });
    assert.equal(persisted.disposition, "REQUESTED_STATE_COMMITTED");
    const pair = await inspectExactPair({
      directory,
      stateName: "integration-simulator",
      expectedKind: "integration-simulator",
      expectedScopeKey: SCOPE_KEY,
    });
    assert.equal(pair.pairAuthorityProven, true);
    const bytes = JSON.parse(
      await readFile(path.join(directory, "integration-simulator.json"), "utf8"),
    );
    const restored = DeterministicSimulator.fromSnapshot(bytes.payload);
    // Reconcile persisted ownership and overlapping authoritative execution observations.
    const order = restored.listOpenOrders()[0];
    assert.ok(order);
    assert.equal(
      restored.classifyObserved({ ...order, scopeKey: SCOPE_KEY, anchorEpoch: "epoch-1" }),
      "OWNED",
    );
    restored.applyExecution({
      executionId: FIXTURE.executionId,
      exchangeOrderId: order.exchangeOrderId,
      quantity: FIXTURE.executionQuantity,
      price: FIXTURE.executionPrice,
    });
    assert.equal(restored.listExecutions().length, 1);
    assert.equal(restored.getPosition().quantity, FIXTURE.executionQuantity);
    assert.equal(canonicalHash(restored.exportSnapshot()), canonicalHash(economic));
    const exposure = restored.possibleExposure();
    const continued = await applyRiskDecision(
      context,
      baselineRiskInput({
        signedPosition: exposure.signedPosition,
        ownedActiveOrders: exposure.ownedWorkingRiskIncreasing.map((row) => ({
          side: row.side,
          price:
            row.price ??
            (() => {
              throw new Error("UNBOUNDED_ORDER_PRICE");
            })(),
          remainingQuantity: row.quantity,
          reduceOnly: false,
          owned: true,
        })),
      }),
    );
    assert.equal(continued.runtimeDisposition, "RUNNING");
    // Hash complete persisted simulator state + deterministic observed decision.
    // Host-local lease nonce/directory are not economic fixture inputs.
    finalHash = canonicalHash({
      simulator: restored.exportSnapshot(),
      continuation: {
        disposition: continued.runtimeDisposition,
        reasons: continued.reasonCodes,
        allowRiskIncrease: continued.allowRiskIncrease,
      },
    });
  });
  return finalHash;
}

export async function duplicateEffects(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const sim = DeterministicSimulator.create(testInit());
    const first = plan(sim);
    const repeated = plan(sim);
    assert.deepEqual(first.intents, repeated.intents);
    // Harness coordinator records submitted intent identity before invoking the fake adapter.
    const outcomes = new Map<string, ReturnType<typeof sim.submit>>();
    const observe = async () => {
      if (outcomes.has(first.entry.intentId)) return;
      const allowed = await applyRiskDecision(
        context,
        baselineRiskInput({
          proposedBatch: first.intents.map(({ side, price, quantity, reduceOnly, purpose }) => ({
            side,
            price,
            quantity,
            reduceOnly,
            purpose,
          })),
        }),
      );
      assert.equal(allowed.allowRiskIncrease, true);
      outcomes.set(first.entry.intentId, sim.submit(first.entry.intentId, "ACK"));
    };
    await observe();
    await observe();
    assert.equal(sim.listOpenOrders().length, 1);
    const order = sim.listOpenOrders()[0];
    assert.ok(order);
    const execution = {
      executionId: FIXTURE.executionId,
      exchangeOrderId: order.exchangeOrderId,
      quantity: FIXTURE.executionQuantity,
      price: FIXTURE.executionPrice,
    };
    sim.applyExecution(execution);
    sim.applyExecution(execution);
    assert.equal(sim.listExecutions().length, 1);
    assert.equal(sim.getPosition().quantity, FIXTURE.executionQuantity);
  });
}

export async function ambiguousOutcome(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const sim = DeterministicSimulator.create(testInit());
    const { entry } = plan(sim);
    assert.equal(sim.submit(entry.intentId, "UNKNOWN").kind, "UNKNOWN");
    assert.equal(sim.listOpenOrders().length, 0);
    assert.equal(sim.level("B1").state, "RECONCILING");
    const restored = DeterministicSimulator.fromSnapshot(sim.exportSnapshot());
    assert.equal(restored.canIncreaseRisk(), false);
    const reservations = restored.possibleExposure().unknownSubmissions;
    assert.equal(reservations.length, 1);
    const result = await applyRiskDecision(
      context,
      baselineRiskInput({
        unknownReservations: reservations.map((row) => ({
          price: row.price,
          quantity: row.quantity,
          side: entry.side,
        })),
        reconciliation: { unresolved: true },
      }),
    );
    assert.equal(result.allowRiskIncrease, false);
    assert.notEqual(result.runtimeDisposition, "RUNNING");
  });
}

export async function staleInput(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const sim = DeterministicSimulator.create(testInit());
    sim.markSnapshotStale();
    assert.equal(sim.canIncreaseRisk(), false);
    assert.equal(sim.planEntries().status, "PLANNED");
    const result = await applyRiskDecision(
      context,
      baselineRiskInput({
        freshness: {
          evaluatedAt: "1000000",
          maxStaleMs: "1000",
          markObservedAt: "0",
          equityObservedAt: "0",
          positionObservedAt: "0",
          pnlObservedAt: "0",
        },
      }),
    );
    assert.equal(result.allowRiskIncrease, false);
    assert.notEqual(result.runtimeDisposition, "RUNNING");
    assert.equal(sim.listOpenOrders().length, 0);
  });
}

export async function fenced(kind: "process" | "expired" | "mismatched" | "persistence"): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    if (kind === "process") context.processFence.trip();
    if (kind === "persistence") context.latch.block(["IO_FAILURE"]);
    if (kind === "expired") context.leaseClock = fixedLeaseClock(NOW_MS + LEASE_TTL_MS);
    if (kind === "mismatched") context.leaseAuthority = { ...context.leaseAuthority, generation: "999" };
    const sim = DeterministicSimulator.create(testInit());
    const { entry } = plan(sim);
    const result = await applyRiskDecision(context, baselineRiskInput());
    assert.equal(result.allowRiskIncrease, false);
    assert.equal(result.systemAllowRiskIncrease, false);
    assert.equal(result.runtimeDisposition, "FAIL_CLOSED");
    if (result.allowRiskIncrease) sim.submit(entry.intentId, "ACK");
    assert.equal(sim.listOpenOrders().length, 0);
    if (kind === "expired" || kind === "mismatched") {
      const sent = await runLeaseFencedMutation({
        directory,
        scopeKey: SCOPE_KEY,
        authority: context.leaseAuthority,
        latch: context.latch,
        clock: context.leaseClock,
        mutation: async () => sim.submit(entry.intentId, "ACK"),
      });
      assert.equal(sent.callbackCount, 0);
      assert.equal(sent.outcome, "NOT_SENT");
    }
  });
}

export async function unresolvedExposure(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const loaded = await loadHaltAuthority({ directory, scopeKey: SCOPE_KEY });
    assert.ok(loaded.ok);
    const saved = await persistHaltTransition({
      directory,
      scopeKey: SCOPE_KEY,
      expectedGeneration: loaded.generation,
      expectedPredecessorEnvelopeSha256: loaded.envelopeSha256,
      payload: makeHaltRecord({ ...loaded.record, unresolvedPossibleExposure: true }),
      latch: context.latch,
    });
    assert.equal(saved.disposition, "REQUESTED_STATE_COMMITTED");
    const result = await applyRiskDecision(context, baselineRiskInput());
    assert.equal(result.runtimeDisposition, "FAIL_CLOSED");
    assert.equal(result.allowRiskIncrease, false);
    assert.ok(result.reasonCodes.includes("UNRESOLVED_UNKNOWN"));
  });
}

export async function freshProcessHalt(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const halted = await executeHardHalt(context, {
      haltReasons: ["DAILY_LOSS"],
      lastRiskEvaluationAt: "1000000",
    });
    assert.equal(halted.durableStatus, "HALTED_FLAT");
    const released = await releaseRuntimeLease({
      directory,
      scopeKey: SCOPE_KEY,
      authority: context.leaseAuthority,
      latch: context.latch,
      clock: context.leaseClock,
    });
    assert.equal(released.disposition, "RELEASED");
    const worker = fileURLToPath(new URL("./reload-worker.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", worker, directory], {
      encoding: "utf8",
      env: process.env,
      timeout: 30000,
    });
    assert.equal(child.status, 0, child.stderr);
    const reloaded = JSON.parse(child.stdout);
    assert.equal(reloaded.beforeStatus, "HALTED_FLAT");
    assert.equal(reloaded.beforeHaltId, halted.haltId);
    assert.equal(reloaded.beforeAcknowledgement, null);
    assert.equal(reloaded.beforeRiskIncrease, false);
    assert.equal(reloaded.missingAckCommitted, false);
    assert.equal(reloaded.validAckCommitted, true);
    assert.equal(reloaded.afterStatus, "RUNNING");
  });
}

export async function ackAuthority(): Promise<void> {
  await withTempDir(async (directory) => {
    const { context } = await seedHaltContext(directory, { orders: [] });
    const halted = await executeHardHalt(context, {
      haltReasons: ["DAILY_LOSS"],
      lastRiskEvaluationAt: "1000000",
    });
    const wrong = await acknowledgeHalt(context, { suppliedHaltId: "wrong1" });
    assert.equal(wrong.acknowledgementCommitted, false);
    assert.equal(wrong.allowRiskIncrease, false);
    const goodTransport = context.transport;
    context.transport = {
      ...goodTransport,
      async freshSnapshot() {
        return snapshot({ leaseGeneration: context.leaseAuthority.generation, fresh: false });
      },
    };
    const unsafe = await acknowledgeHalt(context, { suppliedHaltId: halted.haltId });
    assert.equal(unsafe.acknowledgementCommitted, false);
    assert.equal(unsafe.allowRiskIncrease, false);
    context.transport = goodTransport;
    const good = await acknowledgeHalt(context, { suppliedHaltId: halted.haltId });
    assert.equal(good.acknowledgementCommitted, true);
    assert.equal(good.inspection.pairAuthorityProven, true);
    assert.equal(good.record?.acknowledgement?.acknowledgedHaltId, halted.haltId);
    assert.equal((await inspectHaltContinuation(context)).runtimeDisposition, "RUNNING");
  });
}

export async function runScenarios() {
  const checks: string[] = [];
  const record = async (name: string, run: () => Promise<unknown>) => {
    await run();
    checks.push(name);
  };
  const first = await normalProgression();
  checks.push("normal-strategy-risk-execution-persistence-reload-reconciliation");
  await record("duplicate-observation-intent-execution", duplicateEffects);
  await record("ambiguous-write-is-not-success", ambiguousOutcome);
  await record("stale-input-fails-closed", staleInput);
  await record("process-fence", () => fenced("process"));
  await record("expired-lease", () => fenced("expired"));
  await record("mismatched-lease", () => fenced("mismatched"));
  await record("persistence-latch", () => fenced("persistence"));
  await record("unresolved-exposure-blocks-continue", unresolvedExposure);
  await record("fresh-process-halt-no-auto-ack-valid-durable-ack", freshProcessHalt);
  await record("ack-durable-authority-conditions", ackAuthority);
  const second = await normalProgression();
  assert.equal(first, second);
  checks.push("same-fixture-canonical-replay");
  return {
    mode: "OFFLINE_INTEGRATION",
    liveExchangeWrites: false,
    networkAccessRequired: false,
    replayDeterministic: true,
    authorizationGranted: false,
    fixtureSha256: canonicalHash(FIXTURE),
    finalCanonicalStateHash: first,
    replayCanonicalStateHash: second,
    checks,
    canonicalStateScope:
      "full simulator snapshot plus continuation decision; host-local lease nonces excluded",
  };
}
