import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecutionObservation, OrderIntent } from "../../src/domain/types.js";
import {
  type ContinuationDecision,
  createHaltAuthorityPort,
  decideContinuation,
  type ExecutionReplayResult,
  type FenceResult,
  type HaltAuthorityPort,
  type MutationFence,
  type RiskAccountInputs,
  type RiskInputSource,
  runRestartGate,
} from "../../src/execution/index.js";
import { executeHardHalt, HaltProcessFence } from "../../src/halt/index.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { seedHaltContext, withTempDir } from "../halt/helpers.js";
import {
  buildIntent,
  createHarness,
  freshRiskInputs,
  grant,
  type Harness,
  riskSource,
  runningHaltAuthority,
} from "./helpers.js";

const GRANTED_CODES = [
  "CONTINUATION_GRANTED",
  "CONTINUE_METRICS_ONLY",
  "DURABLE_HALT_OR_ACK_UNAVAILABLE",
  "DURABLE_HALT_RUNNING",
  "HIGH_WATER_OBSERVED",
];

function entry(level: string, sequence: string, quantity = "0.01"): OrderIntent {
  return buildIntent({ logicalLevelId: level, sequence, quantity });
}

function exitIntent(sequence = "1"): OrderIntent {
  return buildIntent({
    logicalLevelId: "S1",
    purpose: "GRID_EXIT",
    side: "SELL",
    reduceOnly: true,
    sequence,
  });
}

function riskWith(overrides: Partial<RiskAccountInputs>): RiskInputSource {
  return riskSource({ ...freshRiskInputs(), ...overrides });
}

// A risk source whose inputs a test can replace between gate evaluations.
function mutableRisk(): RiskInputSource & { set(next: Partial<RiskAccountInputs>): void } {
  let current = freshRiskInputs();
  return {
    read: async () => structuredClone(current),
    set(next) {
      current = { ...freshRiskInputs(), ...next };
    },
  };
}

// A source whose read returns whatever value the test gives, typed or not.
function rawRisk(read: () => Promise<unknown>): RiskInputSource {
  return { read: read as RiskInputSource["read"] };
}

function haltReturning(read: () => Promise<unknown>): HaltAuthorityPort {
  return { inspect: read as HaltAuthorityPort["inspect"] };
}

// A halt authority whose view a test can replace between gate evaluations.
function mutableHalt(): HaltAuthorityPort & { set(view: unknown): void } {
  let current: unknown = {
    durableStatus: "RUNNING",
    allowRiskIncrease: true,
    reasonCodes: ["DURABLE_HALT_RUNNING"],
  };
  return {
    inspect: async () =>
      structuredClone(current) as Awaited<ReturnType<HaltAuthorityPort["inspect"]>>,
    set(view) {
      current = view;
    },
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withSequence(execution: ExecutionObservation, sequence: string): ExecutionObservation {
  const copy = structuredClone(execution);
  copy.meta.sequence = sequence;
  return copy;
}

function assertDenied(decision: ContinuationDecision, action: string, codes: string[]): void {
  assert.equal(decision.action, action);
  assert.equal(decision.allowRiskIncrease, false);
  assert.equal(decision.reasonCodes.includes("CONTINUATION_GRANTED"), false);
  for (const code of codes) {
    assert.ok(decision.reasonCodes.includes(code), `${code} in ${decision.reasonCodes.join(",")}`);
  }
}

async function assertEntryRefused(h: Harness, sequence: string): Promise<void> {
  const placed = h.venue.calls.place;
  const result = await h.coordinator.submit(entry(`B${sequence}`, sequence));
  assert.equal(result.disposition, "REFUSED");
  assert.deepEqual(result.reasonCodes, ["CONTINUATION_NOT_GRANTED"]);
  assert.equal(h.venue.calls.place, placed);
}

async function placeEntry(h: Harness, intent: OrderIntent): Promise<void> {
  await grant(h.coordinator);
  const placed = await h.coordinator.submit(intent);
  assert.equal(placed.record?.status, "LINKED");
}

describe("P3-C01 a CONTINUE decision grants exactly one risk-increasing operation", () => {
  test("a fresh flat account under a RUNNING halt record grants one submit", async () => {
    const h = await createHarness();
    const decision = await h.coordinator.evaluateContinuation("epoch-1");

    assert.equal(decision.action, "CONTINUE");
    assert.equal(decision.allowRiskIncrease, true);
    assert.equal(decision.haltStatus, "RUNNING");
    assert.equal(decision.evaluatedAt, "1000000");
    assert.equal(decision.risk?.action, "CONTINUE");
    assert.deepEqual(decision.reasonCodes, GRANTED_CODES);

    const first = await h.coordinator.submit(entry("B1", "1"));
    assert.equal(first.record?.status, "LINKED");
    await assertEntryRefused(h, "2");
    assert.equal(h.venue.calls.place, 1);
  });

  test("without the gate a risk-increasing submit is refused, even after the restart gate", async () => {
    const h = await createHarness();
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    await assertEntryRefused(h, "1");

    const restart = await runRestartGate(h.coordinator, "epoch-1");
    assert.equal(restart.allowRiskIncrease, true);
    await assertEntryRefused(h, "2");
    assert.equal(h.venue.calls.place, 0);
  });

  test("one grant covers one whole batch and the next batch is refused", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const batch = await h.coordinator.submitBatch([entry("B1", "1"), entry("B2", "2")]);
    assert.equal(batch.disposition, "SUBMITTED");
    assert.equal(h.venue.calls.place, 2);

    const next = await h.coordinator.submitBatch([entry("B3", "3")]);
    assert.deepEqual(next, {
      disposition: "REFUSED",
      reasonCodes: ["CONTINUATION_NOT_GRANTED"],
      items: [],
    });
    assert.equal(h.venue.calls.place, 2);
  });

  test("a refused submit or a reduce-only exit still uses the grant up", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    const wrongLease = await h.coordinator.submit(buildIntent({ leaseGeneration: "2" }));
    assert.deepEqual(wrongLease.reasonCodes, ["INTENT_LEASE_GENERATION_MISMATCH"]);
    await assertEntryRefused(h, "1");

    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(exitIntent())).record?.status, "LINKED");
    await assertEntryRefused(h, "2");
  });

  test("a batch with only exits needs no grant and uses an existing one up", async () => {
    const h = await createHarness();
    const exits = await h.coordinator.submitBatch([exitIntent("1")]);
    assert.equal(exits.disposition, "SUBMITTED");

    await grant(h.coordinator);
    assert.equal((await h.coordinator.submitBatch([exitIntent("2")])).disposition, "SUBMITTED");
    await assertEntryRefused(h, "1");
  });
});

describe("P3-C02 every other operation revokes a grant", () => {
  const revokers: Array<[string, (h: Harness) => Promise<unknown>]> = [
    ["startCycle", async (h) => assert.equal(h.coordinator.startCycle(), true)],
    ["scanOpenOrders", (h) => h.coordinator.scanOpenOrders("epoch-1")],
    ["replayExecutions", (h) => h.coordinator.replayExecutions()],
    ["reconcileUnresolved", (h) => h.coordinator.reconcileUnresolved()],
    ["cancel of an unknown intent", (h) => h.coordinator.cancel(entry("B9", "9").intentId)],
    ["cleanupOwnedDuplicates", (h) => h.coordinator.cleanupOwnedDuplicates("epoch-1")],
  ];
  for (const [name, revoke] of revokers) {
    test(`${name} revokes the grant`, async () => {
      const h = await createHarness();
      await grant(h.coordinator);
      await revoke(h);
      assert.equal(h.coordinator.canIncreaseRisk(), true);
      await assertEntryRefused(h, "1");
    });
  }

  test("an in-sequence stream execution revokes the grant", async () => {
    const h = await createHarness();
    await placeEntry(h, entry("B1", "1"));
    h.coordinator.executionStreamReconnected();
    await h.coordinator.replayExecutions();
    await grant(h.coordinator);

    const fill = withSequence(h.venue.fill("sim-order-1", "0.004", "100"), "1");
    assert.deepEqual(await h.coordinator.ingestStreamExecution(fill), {
      reasonCodes: [],
      recorded: ["sim-exec-1"],
    });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    await assertEntryRefused(h, "2");
  });

  // The reconnect also clears the grant, but its own blocker already refuses the submit, and
  // the replay that clears that blocker revokes the grant again.
  test("a stream reconnect blocks a granted submit until a later gate replays", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    h.coordinator.executionStreamReconnected();
    const result = await h.coordinator.submit(entry("B1", "1"));
    assert.deepEqual(result.reasonCodes, ["EXECUTION_REPLAY_BLOCKS_RISK_INCREASE"]);
    assert.equal(h.venue.calls.place, 0);

    await h.coordinator.replayExecutions();
    await assertEntryRefused(h, "2");
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(entry("B3", "3"))).record?.status, "LINKED");
  });

  test("read-only queries keep the grant", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    h.coordinator.canIncreaseRisk();
    h.coordinator.riskIncreaseBlockers();
    h.coordinator.exposureReservation();
    h.coordinator.isJournalLatched();
    assert.equal((await h.coordinator.submit(entry("B1", "1"))).record?.status, "LINKED");
  });

  test("a denied re-evaluation revokes an earlier grant", async () => {
    const risk = mutableRisk();
    const h = await createHarness({ riskInputs: risk });
    await grant(h.coordinator);
    risk.set({ markOrMidPrice: null });
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "STALE_OR_MISSING_INPUT",
    ]);
    await assertEntryRefused(h, "1");
  });
});

describe("P3-C03 the gate is exclusive", () => {
  test("a second gate or a submit while the gate reads is refused as busy", async () => {
    const reached = deferred();
    const release = deferred();
    let reads = 0;
    // Only the first read waits, so a second gate that is not refused completes and fails the
    // assertion below instead of hanging.
    const h = await createHarness({
      riskInputs: {
        read: async () => {
          reads += 1;
          if (reads === 1) {
            reached.resolve();
            await release.promise;
          }
          return freshRiskInputs();
        },
      },
    });
    const pending = h.coordinator.evaluateContinuation("epoch-1");
    await reached.promise;

    assert.deepEqual(await h.coordinator.evaluateContinuation("epoch-1"), {
      action: "HALT",
      allowRiskIncrease: false,
      reasonCodes: ["COORDINATOR_BUSY"],
      evaluatedAt: null,
      risk: null,
      haltStatus: null,
    });
    assert.deepEqual((await h.coordinator.submit(entry("B1", "1"))).reasonCodes, [
      "COORDINATOR_BUSY",
    ]);
    assert.equal(h.coordinator.startCycle(), false);
    assert.equal(reads, 1);

    release.resolve();
    assert.equal((await pending).allowRiskIncrease, true);
    assert.equal((await h.coordinator.submit(entry("B1", "1"))).record?.status, "LINKED");
  });
});

describe("P3-C04 unusable risk inputs fail closed", () => {
  const sources: Array<[string, () => Promise<unknown>]> = [
    [
      "a rejected read",
      async () => {
        throw new Error("TEST_RISK_READ_FAILED");
      },
    ],
    ["null", async () => null],
    ["undefined", async () => undefined],
    ["an array", async () => [freshRiskInputs()]],
    ["a string", async () => JSON.stringify(freshRiskInputs())],
    ["a number", async () => 1],
    ["ownedActiveOrders", async () => ({ ...freshRiskInputs(), ownedActiveOrders: [] })],
    ["unknownReservations", async () => ({ ...freshRiskInputs(), unknownReservations: [] })],
    ["proposedBatch", async () => ({ ...freshRiskInputs(), proposedBatch: [] })],
    ["haltAuthorityClear", async () => ({ ...freshRiskInputs(), haltAuthorityClear: true })],
    [
      "an undefined coordinator key",
      async () => ({ ...freshRiskInputs(), ownedActiveOrders: undefined }),
    ],
    [
      "a throwing getter",
      async () =>
        Object.defineProperty(freshRiskInputs(), "equity", {
          enumerable: true,
          get() {
            throw new Error("TEST_GETTER");
          },
        }),
    ],
    [
      "a throwing proxy",
      async () =>
        new Proxy(freshRiskInputs(), {
          getOwnPropertyDescriptor() {
            throw new Error("TEST_PROXY");
          },
        }),
    ],
  ];
  for (const [name, read] of sources) {
    test(`${name} denies risk increase`, async () => {
      const h = await createHarness({ riskInputs: rawRisk(read) });
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(decision, "HALT", ["RISK_INPUT_UNAVAILABLE", "INVALID_RISK_INPUT"]);
      assert.equal(decision.risk?.action, "HALT");
      assert.equal(decision.risk?.riskMetricsWithinLimits, false);
      await assertEntryRefused(h, "1");
    });
  }
});

describe("P3-C05 the frozen risk rules deny risk increase", () => {
  const fresh = freshRiskInputs();
  const cases: Array<[string, Partial<RiskAccountInputs>, string[]]> = [
    [
      "stale equity",
      { freshness: { ...fresh.freshness, equityObservedAt: "998999" } },
      ["STALE_OR_MISSING_INPUT"],
    ],
    [
      "a future observation",
      { freshness: { ...fresh.freshness, pnlObservedAt: "1000001" } },
      ["STALE_OR_MISSING_INPUT"],
    ],
    ["a missing mark", { markOrMidPrice: null }, ["STALE_OR_MISSING_INPUT"]],
    ["a missing position", { signedPosition: null }, ["STALE_OR_MISSING_INPUT"]],
    ["a missing fee", { fees: null }, ["FEE_MISSING", "STALE_OR_MISSING_INPUT"]],
    [
      "a lost lease",
      { lease: { proven: true, expired: false, lost: true } },
      ["LEASE_LOST", "LEASE_UNPROVEN"],
    ],
    [
      "an expired lease",
      { lease: { proven: true, expired: true, lost: false } },
      ["LEASE_EXPIRED", "LEASE_UNPROVEN"],
    ],
    ["a blocked latch", { latchBlocked: true }, ["LATCH_BLOCKED", "PERSISTENCE_UNPROVEN"]],
    [
      "an unproven pair",
      { durableInspection: { pairAuthorityProven: false } },
      ["PAIR_UNPROVEN", "PERSISTENCE_UNPROVEN"],
    ],
    [
      "unresolved account reconciliation",
      { reconciliation: { unresolved: true } },
      ["RECONCILIATION_REQUIRED"],
    ],
    ["the daily loss limit", { realizedTradingPnl: "-5" }, ["DAILY_LOSS"]],
    ["the start drawdown limit", { equity: "90" }, ["START_DRAWDOWN"]],
    [
      "a long position below the band",
      { signedPosition: "0.1", markOrMidPrice: "96" },
      ["BOUNDARY"],
    ],
    [
      "a short position above the band",
      { signedPosition: "-0.1", markOrMidPrice: "104.1" },
      ["BOUNDARY"],
    ],
  ];
  for (const [name, overrides, codes] of cases) {
    test(`${name} halts`, async () => {
      const h = await createHarness({ riskInputs: riskWith(overrides) });
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(decision, "HALT", codes);
      assert.equal(decision.risk?.action, "HALT");
      await assertEntryRefused(h, "1");
    });
  }

  test("a flat position outside the band blocks seeding but still allows exits", async () => {
    for (const markOrMidPrice of ["105", "95"]) {
      const h = await createHarness({ riskInputs: riskWith({ markOrMidPrice }) });
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(decision, "CONTINUE", ["BOUNDARY_SEED_BLOCKED"]);
      assert.equal(decision.risk?.riskMetricsWithinLimits, true);
      await assertEntryRefused(h, "1");
      assert.equal((await h.coordinator.submit(exitIntent())).record?.status, "LINKED");
    }
  });
});

describe("P3-C06 actual notional above the cap never continues", () => {
  test("a boundable reduction is REDUCE: entries refused, exits allowed", async () => {
    const h = await createHarness({ riskInputs: riskWith({ signedPosition: "2" }) });
    const decision = await h.coordinator.evaluateContinuation("epoch-1");
    assertDenied(decision, "REDUCE", ["ACTUAL_NOTIONAL"]);
    assert.equal(decision.risk?.action, "REDUCE");
    await assertEntryRefused(h, "1");
    assert.equal((await h.coordinator.submit(exitIntent())).record?.status, "LINKED");
  });

  const unboundable: Array<[string, Partial<RiskAccountInputs["boundedReduction"]>, string]> = [
    ["cancel-only reduction", { cancelOnly: true }, "CANCEL_ONLY_REDUCTION"],
    ["an ambiguous reduction", { ambiguous: true }, "REDUCTION_AMBIGUOUS"],
    ["an impossible reduction", { possible: false }, "REDUCTION_NOT_PROVEN"],
    ["a stale reduction snapshot", { snapshotFresh: false }, "REDUCTION_NOT_PROVEN"],
  ];
  for (const [name, reduction, code] of unboundable) {
    test(`${name} halts`, async () => {
      const boundedReduction = { ...freshRiskInputs().boundedReduction, ...reduction };
      const h = await createHarness({
        riskInputs: riskWith({ signedPosition: "2", boundedReduction }),
      });
      assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
        "ACTUAL_NOTIONAL",
        code,
      ]);
      await assertEntryRefused(h, "1");
    });
  }
});

describe("P3-C07 the coordinator's own working orders count toward planned notional", () => {
  test("a working entry plus the account position above the cap halts until cancelled", async () => {
    const risk = mutableRisk();
    const h = await createHarness({ riskInputs: risk });
    const big = entry("B1", "1", "1.4");
    await placeEntry(h, big);

    risk.set({ signedPosition: "0.2" });
    const decision = await h.coordinator.evaluateContinuation("epoch-1");
    assertDenied(decision, "HALT", ["PLANNED_NOTIONAL"]);
    assert.equal(decision.risk?.metrics.worstLongNotional, "160");

    assert.deepEqual((await h.coordinator.cancel(big.intentId)).reasonCodes, ["CANCEL_ACK"]);

    // The gate's own reconcile observes the cancel before the reservation is released.
    const after = await grant(h.coordinator);
    assert.equal(h.registry.get(big.intentId)?.status, "CANCELLED");
    assert.equal(after.risk?.metrics.worstLongNotional, "20");
  });

  test("an order whose ack was lost is reconciled by the gate and then counted", async () => {
    let loseNext = true;
    const fence: MutationFence = {
      leaseGeneration: "1",
      async run<T>(mutation: () => Promise<T>): Promise<FenceResult<T>> {
        const value = await mutation();
        if (loseNext) {
          loseNext = false;
          return { outcome: "UNKNOWN", value: null, reasonCodes: ["TEST_ACK_LOST"] };
        }
        return { outcome: "SENT", value, reasonCodes: [] };
      },
    };
    const h = await createHarness({ fence });
    await grant(h.coordinator);
    assert.equal((await h.coordinator.submit(entry("B1", "1"))).record?.status, "UNKNOWN");
    assert.equal(h.coordinator.canIncreaseRisk(), false);

    const decision = await grant(h.coordinator);
    assert.equal(decision.risk?.metrics.worstLongNotional, "1");
    assert.equal(h.coordinator.canIncreaseRisk(), true);
  });
});

describe("P3-C08 coordinator blockers deny risk increase", () => {
  test("a foreign open order found by the gate's own scan halts", async () => {
    const h = await createHarness();
    h.venue.addForeignOrder({
      clientOrderId: "manual-1",
      side: "BUY",
      price: "99",
      quantity: "0.01",
    });
    h.venue.addForeignOrder({ clientOrderId: null, side: "SELL", price: "101", quantity: "0.01" });
    assert.equal(h.coordinator.canIncreaseRisk(), true);
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "AMBIGUOUS_OPEN_ORDER",
      "RECONCILIATION_REQUIRED",
      "UNOWNED_OPEN_ORDER",
    ]);
    const refused = await h.coordinator.submit(entry("B1", "1"));
    assert.deepEqual(refused.reasonCodes, ["OPEN_ORDER_SCAN_BLOCKS_RISK_INCREASE"]);
    assert.equal(h.venue.calls.place, 0);
  });

  test("a latched journal halts", async () => {
    const h = await createHarness();
    await grant(h.coordinator);
    h.journal.scriptPersist("FAIL");
    await h.coordinator.submit(entry("B1", "1"));
    assert.equal(h.coordinator.isJournalLatched(), true);
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "JOURNAL_LATCHED",
      "RECONCILIATION_REQUIRED",
    ]);
  });

  test("the gate runs its own replay and scan before it decides", async () => {
    const h = await createHarness({ replay: false, scan: false });
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [
      "EXECUTION_REPLAY_INCOMPLETE",
      "OPEN_ORDER_SCAN_REQUIRED",
    ]);
    assert.equal((await grant(h.coordinator)).action, "CONTINUE");

    h.coordinator.executionStreamReconnected();
    assert.equal((await grant(h.coordinator)).action, "CONTINUE");
    assert.equal((await h.coordinator.submit(entry("B1", "1"))).record?.status, "LINKED");
  });

  test("a reconnect or a dropped execution while the gate reads its inputs halts", async () => {
    let during = (_h: Harness) => {};
    let current: Harness | null = null;
    const halt: HaltAuthorityPort = {
      inspect: async () => {
        if (current !== null) {
          during(current);
        }
        return runningHaltAuthority().inspect();
      },
    };
    const h = await createHarness({ haltAuthority: halt });
    current = h;
    during = (target) => target.coordinator.executionStreamReconnected();
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "EXECUTION_STREAM_RECONNECTED",
      "RECONCILIATION_REQUIRED",
    ]);
    const refused = await h.coordinator.submit(entry("B1", "1"));
    assert.deepEqual(refused.reasonCodes, ["EXECUTION_REPLAY_BLOCKS_RISK_INCREASE"]);
    assert.equal(h.venue.calls.place, 0);

    during = () => {};
    await placeEntry(h, entry("B1", "1"));
    const dropped: Array<Promise<ExecutionReplayResult>> = [];
    during = (target) => {
      dropped.push(
        target.coordinator.ingestStreamExecution(
          withSequence(target.venue.fill("sim-order-1", "0.004", "100"), "1"),
        ),
      );
    };
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "EXECUTION_STREAM_EVENT_DROPPED",
      "RECONCILIATION_REQUIRED",
    ]);
    const [result] = await Promise.all(dropped);
    assert.deepEqual(result?.recorded, []);
    assert.ok(result?.reasonCodes.includes("COORDINATOR_BUSY"));
  });
});

describe("P3-C09 the durable halt authority must allow risk increase", () => {
  const views: Array<[string, unknown, string[], string | null]> = [
    [
      "a halted record",
      {
        durableStatus: "HALTED_FLAT",
        allowRiskIncrease: false,
        reasonCodes: ["RISK_INCREASE_FENCED"],
      },
      ["HALT_AUTHORITY_DENIED", "RISK_INCREASE_FENCED"],
      "HALTED_FLAT",
    ],
    [
      "a fail-closed RUNNING record",
      { durableStatus: "RUNNING", allowRiskIncrease: false, reasonCodes: ["LEASE_UNCERTAIN"] },
      ["HALT_AUTHORITY_DENIED", "LEASE_UNCERTAIN"],
      "RUNNING",
    ],
    [
      "a halted record that claims to allow risk increase",
      { durableStatus: "HALTED_FLAT", allowRiskIncrease: true, reasonCodes: [] },
      ["HALT_AUTHORITY_DENIED"],
      "HALTED_FLAT",
    ],
    ["null", null, ["HALT_AUTHORITY_DENIED", "HALT_AUTHORITY_UNAVAILABLE"], null],
    ["an empty object", {}, ["HALT_AUTHORITY_DENIED", "HALT_AUTHORITY_UNAVAILABLE"], null],
    [
      "a non-string status",
      { durableStatus: 1, allowRiskIncrease: true, reasonCodes: [] },
      ["HALT_AUTHORITY_UNAVAILABLE"],
      null,
    ],
    [
      "a string allowRiskIncrease",
      { durableStatus: "RUNNING", allowRiskIncrease: "true", reasonCodes: [] },
      ["HALT_AUTHORITY_UNAVAILABLE"],
      null,
    ],
    [
      "missing reason codes",
      { durableStatus: "RUNNING", allowRiskIncrease: true },
      ["HALT_AUTHORITY_UNAVAILABLE"],
      null,
    ],
    [
      "a non-string reason code",
      { durableStatus: "RUNNING", allowRiskIncrease: true, reasonCodes: [1] },
      ["HALT_AUTHORITY_UNAVAILABLE"],
      null,
    ],
  ];
  for (const [name, view, codes, haltStatus] of views) {
    test(`${name} denies risk increase`, async () => {
      const halt = mutableHalt();
      halt.set(view);
      const h = await createHarness({ haltAuthority: halt });
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(decision, "HALT", codes);
      assert.equal(decision.risk?.action, "CONTINUE");
      assert.equal(decision.haltStatus, haltStatus);
      await assertEntryRefused(h, "1");
    });
  }

  test("a rejected or throwing halt inspection denies risk increase", async () => {
    const throwingGetter = Object.defineProperty({}, "durableStatus", {
      get() {
        throw new Error("TEST_GETTER");
      },
    });
    const reads: Array<() => Promise<unknown>> = [
      async () => {
        throw new Error("TEST_HALT_READ_FAILED");
      },
      async () => throwingGetter,
    ];
    for (const read of reads) {
      const h = await createHarness({ haltAuthority: haltReturning(read) });
      const decision = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(decision, "HALT", ["HALT_AUTHORITY_DENIED", "HALT_AUTHORITY_UNAVAILABLE"]);
      assert.equal(decision.haltStatus, null);
      await assertEntryRefused(h, "1");
    }
  });

  test("iterable reason codes that are not an array deny risk increase", async () => {
    const reasonCodes = {
      every: () => true,
      *[Symbol.iterator]() {
        yield "DURABLE_HALT_RUNNING";
      },
    };
    const h = await createHarness({
      haltAuthority: haltReturning(async () => ({
        durableStatus: "RUNNING",
        allowRiskIncrease: true,
        reasonCodes,
      })),
    });
    const decision = await h.coordinator.evaluateContinuation("epoch-1");
    assertDenied(decision, "HALT", ["HALT_AUTHORITY_DENIED", "HALT_AUTHORITY_UNAVAILABLE"]);
    assert.equal(decision.haltStatus, null);
    await assertEntryRefused(h, "1");
  });
});

describe("P3-C10 a denying gate never writes and never blocks reduction", () => {
  test("under HALT, cancels and exits still run and the gate sends nothing", async () => {
    const halt = mutableHalt();
    const h = await createHarness({ haltAuthority: halt });
    const working = entry("B1", "1");
    await placeEntry(h, working);

    halt.set({
      durableStatus: "HALTED_UNVERIFIED",
      allowRiskIncrease: false,
      reasonCodes: ["RISK_INCREASE_FENCED"],
    });
    const before = { ...h.venue.calls };
    assertDenied(await h.coordinator.evaluateContinuation("epoch-1"), "HALT", [
      "HALT_AUTHORITY_DENIED",
    ]);
    assert.equal(h.venue.calls.place, before.place);
    assert.equal(h.venue.calls.cancel, before.cancel);

    assert.deepEqual((await h.coordinator.cancel(working.intentId)).reasonCodes, ["CANCEL_ACK"]);
    assert.equal(h.venue.calls.cancel, before.cancel + 1);
    await h.coordinator.reconcileUnresolved();
    assert.equal(h.registry.get(working.intentId)?.status, "CANCELLED");
    assert.equal((await h.coordinator.submit(exitIntent())).record?.status, "LINKED");
    await assertEntryRefused(h, "2");
  });

  test("a granting gate sends nothing either", async () => {
    const h = await createHarness();
    const before = { ...h.venue.calls };
    await grant(h.coordinator);
    assert.equal(h.venue.calls.place, before.place);
    assert.equal(h.venue.calls.cancel, before.cancel);
  });
});

describe("P3-C11 the gate reads the real durable halt record", () => {
  test("RUNNING grants; after a hard halt the gate halts, also after a restart", async () => {
    await withTempDir(async (directory) => {
      const { context } = await seedHaltContext(directory, {});
      const h = await createHarness({ haltAuthority: createHaltAuthorityPort(context) });
      const running = await grant(h.coordinator);
      assert.equal(running.haltStatus, "RUNNING");
      assert.ok(running.reasonCodes.includes("DURABLE_HALT_RUNNING"));

      const halted = await executeHardHalt(context, {
        haltReasons: ["DAILY_LOSS"],
        lastRiskEvaluationAt: "1000000",
      });
      assert.equal(halted.durableStatus, "HALTED_FLAT");
      const after = await h.coordinator.evaluateContinuation("epoch-1");
      assertDenied(after, "HALT", ["HALT_AUTHORITY_DENIED", "RISK_INCREASE_FENCED"]);
      assert.equal(after.haltStatus, "HALTED_FLAT");
      await assertEntryRefused(h, "1");

      const restarted = {
        ...context,
        latch: new RuntimePersistenceLatch(),
        processFence: new HaltProcessFence(),
      };
      const fresh = await createHarness({ haltAuthority: createHaltAuthorityPort(restarted) });
      const reopened = await fresh.coordinator.evaluateContinuation("epoch-1");
      assertDenied(reopened, "HALT", ["HALT_AUTHORITY_DENIED", "RISK_INCREASE_FENCED"]);
      assert.equal(reopened.haltStatus, "HALTED_FLAT");
      await assertEntryRefused(fresh, "1");
    });
  });
});

describe("P3-C12 decideContinuation", () => {
  const running = { durableStatus: "RUNNING", allowRiskIncrease: true, reasonCodes: [] };
  const noReservation = { ownedActiveOrders: [], unknownReservations: [] };

  test("blockers are reported as unresolved reconciliation", () => {
    const decision = decideContinuation({
      riskInputs: freshRiskInputs(),
      haltView: running,
      reservation: noReservation,
      blockers: ["OPEN_ORDER_SCAN_REQUIRED"],
    });
    assertDenied(decision, "HALT", ["OPEN_ORDER_SCAN_REQUIRED", "RECONCILIATION_REQUIRED"]);
  });

  test("the source's own unresolved reconciliation is kept without blockers", () => {
    const decision = decideContinuation({
      riskInputs: { ...freshRiskInputs(), reconciliation: { unresolved: true } },
      haltView: running,
      reservation: noReservation,
      blockers: [],
    });
    assertDenied(decision, "HALT", ["RECONCILIATION_REQUIRED"]);
  });

  test("working orders and unknown reservations reach the risk rules", () => {
    const decision = decideContinuation({
      riskInputs: freshRiskInputs(),
      haltView: running,
      reservation: {
        ownedActiveOrders: [
          { side: "BUY", price: "100", remainingQuantity: "1", reduceOnly: false, owned: true },
        ],
        unknownReservations: [{ side: "SELL", price: "100", quantity: "0.5" }],
      },
      blockers: [],
    });
    assert.equal(decision.allowRiskIncrease, true);
    assert.equal(decision.risk?.metrics.worstLongNotional, "100");
    assert.equal(decision.risk?.metrics.worstShortNotional, "50");
  });

  test("reason codes are sorted and unique, and the source is not changed", () => {
    const inputs = freshRiskInputs();
    const copy = structuredClone(inputs);
    const decision = decideContinuation({
      riskInputs: inputs,
      haltView: { ...running, reasonCodes: ["DURABLE_HALT_RUNNING", "CONTINUE_METRICS_ONLY"] },
      reservation: noReservation,
      blockers: [],
    });
    assert.deepEqual(decision.reasonCodes, GRANTED_CODES);
    assert.deepEqual(inputs, copy);
  });
});
