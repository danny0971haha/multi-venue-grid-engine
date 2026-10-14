import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { makeScopeKey } from "../../src/domain/ids.js";
import {
  EXECUTION_CHECKPOINT_KIND,
  EXECUTION_CHECKPOINT_SCHEMA_VERSION,
  EXECUTION_CHECKPOINT_STATE_NAME,
  ExecutionCoordinator,
  type ExecutionVenuePort,
  INTENT_JOURNAL_KIND,
  INTENT_JOURNAL_STATE_NAME,
  IntentRegistry,
  openDurableExecutionState,
  recoverInterruptedIntents,
  runRestartGate,
} from "../../src/execution/index.js";
import { initializeExactPair } from "../../src/persistence/atomic-pair-store.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SimulatedVenue } from "../../src/simulator/venue.js";
import {
  buildIntent,
  createHarness,
  flatExposure,
  MemoryJournal,
  OBSERVED_AT,
  openFence,
  SCOPE_KEY,
} from "./helpers.js";

const SRC_ROOT = fileURLToPath(new URL("../../src/", import.meta.url));
const VALID_CURSOR = {
  venue: "sim",
  market: "BTC_USDC_PERP",
  lastExecutionId: "sim-exec-1",
  lastExecutionTime: OBSERVED_AT,
  opaque: "sim-exec-cursor:1",
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase3e-restart-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function open(directory: string, latch = new RuntimePersistenceLatch()) {
  return openDurableExecutionState({ directory, scopeKey: SCOPE_KEY, latch });
}

async function openOk(directory: string, latch = new RuntimePersistenceLatch()) {
  const state = await open(directory, latch);
  assert.ok(state.ok, state.ok ? "" : state.reasonCodes.join(","));
  return state;
}

function seedPair(directory: string, kind: "journal" | "checkpoint", payload: unknown) {
  return initializeExactPair({
    directory,
    stateName: kind === "journal" ? INTENT_JOURNAL_STATE_NAME : EXECUTION_CHECKPOINT_STATE_NAME,
    expectedKind: kind === "journal" ? INTENT_JOURNAL_KIND : EXECUTION_CHECKPOINT_KIND,
    expectedScopeKey: SCOPE_KEY,
    payload,
    latch: new RuntimePersistenceLatch(),
    bootstrapAuthorization: { mode: "NON_LIVE_BOOTSTRAP", allowLive: false },
  });
}

// Another writer commits the journal first, so an earlier opener's expected predecessor no
// longer matches the pair on disk.
async function advanceJournalElsewhere(directory: string): Promise<void> {
  const other = await openOk(directory);
  await other.journal.persist(other.registry.exportState());
}

function coordinatorOver(
  state: Awaited<ReturnType<typeof openOk>>,
  venue: ExecutionVenuePort,
): ExecutionCoordinator {
  return new ExecutionCoordinator({
    config: {
      experimentId: "exp-1",
      runId: "run-1",
      scopeKey: SCOPE_KEY,
      writeBudgetPerCycle: 100,
    },
    registry: state.registry,
    venue,
    fence: openFence(),
    journal: state.journal,
    exposure: flatExposure(),
    checkpoints: state.checkpoints,
    executionCursor: state.executionCursor,
  });
}

describe("P3E durable intent journal and execution checkpoint", () => {
  test("a fresh directory opens empty and writes the empty journal first", async () => {
    await withDirectory(async (directory) => {
      const first = await openOk(directory);
      assert.deepEqual(first.registry.list(), []);
      assert.equal(first.executionCursor, null);
      assert.ok(readdirSync(directory).includes(`${INTENT_JOURNAL_STATE_NAME}.json`));
      assert.ok(!readdirSync(directory).includes(`${EXECUTION_CHECKPOINT_STATE_NAME}.json`));

      const again = await openOk(directory);
      assert.deepEqual(again.registry.list(), []);
      assert.equal(again.executionCursor, null);
    });
  });

  test("a fresh directory under a blocked latch fails closed and writes no journal", async () => {
    await withDirectory(async (directory) => {
      const latch = new RuntimePersistenceLatch();
      latch.block(["FATAL_UNCAUGHT_EXCEPTION"]);
      assert.deepEqual(await open(directory, latch), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INITIALIZATION_FAILED"],
      });
      assert.deepEqual(readdirSync(directory), []);
    });
  });

  test("intents and the execution cursor survive a reopen, so replay does not recount", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const state = await openOk(directory);
      const coordinator = coordinatorOver(state, venue);
      assert.equal((await runRestartGate(coordinator, "epoch-1")).allowRiskIncrease, true);
      const intent = buildIntent();
      assert.equal((await coordinator.submit(intent)).record?.status, "LINKED");
      venue.fill("sim-order-1", "0.004", "100");
      assert.deepEqual((await coordinator.replayExecutions()).recorded, ["sim-exec-1"]);

      const reopened = await openOk(directory);
      assert.deepEqual(reopened.registry.exportState(), state.registry.exportState());
      assert.equal(reopened.registry.get(intent.intentId)?.executedQuantity, "0.004");
      assert.deepEqual(reopened.executionCursor, VALID_CURSOR);

      const gate = await runRestartGate(coordinatorOver(reopened, venue), "epoch-1");
      assert.equal(gate.allowRiskIncrease, true);
      assert.deepEqual(gate.replay.recorded, []);
      assert.equal(reopened.registry.get(intent.intentId)?.executedQuantity, "0.004");
    });
  });

  test("a checkpoint without its journal fails closed", async () => {
    await withDirectory(async (directory) => {
      await seedPair(directory, "checkpoint", {
        schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
        cursor: VALID_CURSOR,
      });
      const state = await open(directory);
      assert.deepEqual(state, {
        ok: false,
        reasonCodes: ["EXECUTION_CHECKPOINT_WITHOUT_JOURNAL"],
      });
      // Failing closed does not repair anything: the journal is still absent.
      assert.ok(!readdirSync(directory).includes(`${INTENT_JOURNAL_STATE_NAME}.json`));
    });
  });

  test("an unreadable journal is unproven, never treated as empty", async () => {
    await withDirectory(async (directory) => {
      await openOk(directory);
      await writeFile(path.join(directory, `${INTENT_JOURNAL_STATE_NAME}.json`), "{not json");
      const state = await open(directory);
      assert.equal(state.ok, false);
      assert.deepEqual(state.ok ? [] : state.reasonCodes.slice(0, 2), [
        "INTENT_JOURNAL_UNPROVEN",
        "PREDECESSOR_UNPROVEN",
      ]);
    });
  });

  test("an unreadable checkpoint is unproven", async () => {
    await withDirectory(async (directory) => {
      await openOk(directory);
      await seedPair(directory, "checkpoint", {
        schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
        cursor: VALID_CURSOR,
      });
      await writeFile(path.join(directory, `${EXECUTION_CHECKPOINT_STATE_NAME}.json`), "{}");
      const state = await open(directory);
      assert.deepEqual(state.ok ? [] : state.reasonCodes.slice(0, 2), [
        "EXECUTION_CHECKPOINT_UNPROVEN",
        "PREDECESSOR_UNPROVEN",
      ]);
    });
  });

  test("a journal payload that is not a registry state fails closed", async () => {
    await withDirectory(async (directory) => {
      await seedPair(directory, "journal", { records: [] });
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "IMPORT_INVALID_STATE"],
      });
    });
  });

  test("a journal holding another scope's intent fails closed", async () => {
    await withDirectory(async (directory) => {
      const registry = new IntentRegistry();
      registry.prepare(
        buildIntent({ scopeKey: makeScopeKey("canary-02", "sim", "BTC_USDC_PERP", "grid-v0.1") }),
      );
      await seedPair(directory, "journal", registry.exportState());
      assert.deepEqual(await open(directory), {
        ok: false,
        reasonCodes: ["INTENT_JOURNAL_INVALID", "INTENT_SCOPE_MISMATCH"],
      });
    });
  });

  for (const [name, payload] of [
    ["an unknown schema version", { schemaVersion: "other", cursor: VALID_CURSOR }],
    [
      "an extra state key",
      { schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION, cursor: VALID_CURSOR, extra: 1 },
    ],
    [
      "an extra cursor key",
      { schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION, cursor: { ...VALID_CURSOR, x: 1 } },
    ],
    [
      "another market's cursor",
      {
        schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
        cursor: { ...VALID_CURSOR, market: "ETH_USDC_PERP" },
      },
    ],
    [
      "an empty opaque position",
      {
        schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
        cursor: { ...VALID_CURSOR, opaque: "" },
      },
    ],
  ] as const) {
    test(`a checkpoint with ${name} fails closed`, async () => {
      await withDirectory(async (directory) => {
        await openOk(directory);
        await seedPair(directory, "checkpoint", payload);
        assert.deepEqual(await open(directory), {
          ok: false,
          reasonCodes: ["EXECUTION_CHECKPOINT_INVALID"],
        });
      });
    });
  }

  test("a failed journal write blocks the latch, and every later write is refused", async () => {
    await withDirectory(async (directory) => {
      const latch = new RuntimePersistenceLatch();
      const state = await openOk(directory, latch);
      await advanceJournalElsewhere(directory);
      await assert.rejects(
        state.journal.persist(state.registry.exportState()),
        /INTENT_JOURNAL_WRITE_FAILED/,
      );
      assert.equal(latch.blocked, true);
      assert.ok(latch.reasonCodes.includes("INTENT_JOURNAL_WRITE_FAILED"));
      await assert.rejects(
        state.journal.persist(state.registry.exportState()),
        /INTENT_JOURNAL_WRITE_FAILED/,
      );
      await assert.rejects(
        state.checkpoints.persist(VALID_CURSOR),
        /EXECUTION_CHECKPOINT_WRITE_FAILED/,
      );
    });
  });

  test("a latch blocked elsewhere refuses both writers and leaves the pairs as they were", async () => {
    await withDirectory(async (directory) => {
      const latch = new RuntimePersistenceLatch();
      const state = await openOk(directory, latch);
      latch.block(["FATAL_UNCAUGHT_EXCEPTION"]);
      const registry = new IntentRegistry();
      registry.prepare(buildIntent());
      await assert.rejects(
        state.journal.persist(registry.exportState()),
        /INTENT_JOURNAL_WRITE_FAILED/,
      );
      await assert.rejects(
        state.checkpoints.persist(VALID_CURSOR),
        /EXECUTION_CHECKPOINT_WRITE_FAILED/,
      );

      const reopened = await openOk(directory);
      assert.deepEqual(reopened.registry.list(), []);
      assert.equal(reopened.executionCursor, null);
    });
  });

  test("a coordinator whose journal write fails sends nothing", async () => {
    await withDirectory(async (directory) => {
      const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
      const state = await openOk(directory);
      const coordinator = coordinatorOver(state, venue);
      assert.equal((await runRestartGate(coordinator, "epoch-1")).allowRiskIncrease, true);
      await advanceJournalElsewhere(directory);

      const result = await coordinator.submit(buildIntent());
      assert.equal(result.record?.status, "NOT_SENT");
      assert.deepEqual(result.reasonCodes, ["JOURNAL_WRITE_FAILED"]);
      assert.deepEqual(await venue.listOpenOrders(), []);
      assert.ok(coordinator.riskIncreaseBlockers().includes("JOURNAL_LATCHED"));
      const next = await coordinator.submit(buildIntent({ sequence: "2", logicalLevelId: "B2" }));
      assert.equal(next.disposition, "REFUSED");
      assert.deepEqual(next.reasonCodes, ["JOURNAL_LATCHED"]);
    });
  });
});

describe("P3E restart recovery of interrupted intents", () => {
  test("PREPARED becomes UNKNOWN and CANCEL_PREPARED becomes CANCEL_UNVERIFIED in one write", async () => {
    const sending = buildIntent({ sequence: "1", logicalLevelId: "B1" });
    const cancelling = buildIntent({ sequence: "2", logicalLevelId: "B2" });
    const working = buildIntent({ sequence: "3", logicalLevelId: "B3" });
    const registry = new IntentRegistry();
    registry.prepare(sending);
    for (const [intent, exchangeOrderId] of [
      [cancelling, "sim-order-1"],
      [working, "sim-order-2"],
    ] as const) {
      registry.prepare(intent);
      registry.link(intent.intentId, {
        exchangeOrderId,
        authority: { source: "ACK", evidenceId: exchangeOrderId },
        executions: [],
        reasonCodes: ["VENUE_ACK"],
      });
    }
    registry.markCancelPrepared(cancelling.intentId, ["TEST_CANCEL"]);
    const journal = new MemoryJournal();

    const result = await recoverInterruptedIntents(registry, journal);

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.items.map((item) => [item.intentId, item.from, item.to]),
      [
        [sending.intentId, "PREPARED", "UNKNOWN"],
        [cancelling.intentId, "CANCEL_PREPARED", "CANCEL_UNVERIFIED"],
      ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1)),
    );
    assert.equal(journal.snapshots.length, 1);
    const persisted = IntentRegistry.fromState(journal.latest());
    assert.equal(persisted.get(sending.intentId)?.status, "UNKNOWN");
    assert.ok(
      persisted.get(sending.intentId)?.reasonCodes.includes("RESTART_SEND_OUTCOME_UNKNOWN"),
    );
    assert.equal(persisted.get(cancelling.intentId)?.status, "CANCEL_UNVERIFIED");
    assert.equal(persisted.get(working.intentId)?.status, "LINKED");
  });

  test("nothing interrupted means nothing is written", async () => {
    const registry = new IntentRegistry();
    const intent = buildIntent();
    registry.prepare(intent);
    registry.markUnknown(intent.intentId, ["TEST_UNKNOWN"]);
    const journal = new MemoryJournal();
    assert.deepEqual(await recoverInterruptedIntents(registry, journal), {
      ok: true,
      reasonCodes: [],
      items: [],
    });
    assert.equal(journal.snapshots.length, 0);
  });

  test("a failed recovery write is reported and the caller must stop", async () => {
    const registry = new IntentRegistry();
    registry.prepare(buildIntent());
    const journal = new MemoryJournal();
    journal.scriptPersist("FAIL");
    const result = await recoverInterruptedIntents(registry, journal);
    assert.equal(result.ok, false);
    assert.deepEqual(result.reasonCodes, ["RESTART_RECOVERY_WRITE_FAILED"]);
  });
});

describe("P3E restart gate", () => {
  test("a new coordinator refuses risk until the scan and the replay have run", async () => {
    const h = await createHarness({ replay: false, scan: false });
    assert.deepEqual(h.coordinator.riskIncreaseBlockers(), [
      "EXECUTION_REPLAY_INCOMPLETE",
      "OPEN_ORDER_SCAN_REQUIRED",
    ]);
    assert.equal(h.coordinator.canIncreaseRisk(), false);
    const refused = await h.coordinator.submit(buildIntent({ sequence: "1" }));
    assert.equal(refused.disposition, "REFUSED");
    assert.deepEqual(await h.venue.listOpenOrders(), []);

    const gate = await runRestartGate(h.coordinator, "epoch-1");
    assert.equal(gate.allowRiskIncrease, true);
    assert.deepEqual(gate.reasonCodes, []);
    assert.equal(
      (await h.coordinator.submit(buildIntent({ sequence: "2" }))).disposition,
      "RECORDED",
    );
  });

  test("a failed lookup still runs the scan and the replay, and the gate stays closed", async () => {
    const venue = new SimulatedVenue("sim", "BTC_USDC_PERP", OBSERVED_AT);
    const registry = new IntentRegistry();
    const intent = buildIntent();
    registry.prepare(intent);
    registry.markUnknown(intent.intentId, ["RESTART_SEND_OUTCOME_UNKNOWN"]);
    const calls: string[] = [];
    const port: ExecutionVenuePort = {
      placeOrder: (value) => venue.placeOrder(value),
      cancelOrder: (request) => venue.cancelOrder(request),
      lookupClientOrder: async () => {
        calls.push("LOOKUP");
        throw new Error("lookup unavailable");
      },
      listOpenOrders: () => {
        calls.push("LIST");
        return venue.listOpenOrders();
      },
      listExecutionsSince: (cursor) => {
        calls.push("EXECUTIONS");
        return venue.listExecutionsSince(cursor);
      },
    };
    const h = await createHarness({ venue, port, registry, replay: false, scan: false });

    const gate = await runRestartGate(h.coordinator, "epoch-1");

    assert.deepEqual(calls, ["LOOKUP", "LIST", "EXECUTIONS"]);
    assert.equal(gate.allowRiskIncrease, false);
    assert.deepEqual(gate.reasonCodes, ["UNRESOLVED_INTENT"]);
    assert.deepEqual(gate.scan.reasonCodes, []);
    assert.deepEqual(gate.replay.reasonCodes, []);
    assert.equal(registry.get(intent.intentId)?.status, "UNKNOWN");
  });
});

describe("P3E fatal guard ownership", () => {
  test("only the fatal guard registers process-level error handlers in src", () => {
    const offenders: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(full);
        } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          if (
            /uncaughtException|unhandledRejection|setUncaughtExceptionCaptureCallback/.test(text)
          ) {
            offenders.push(path.relative(SRC_ROOT, full));
          }
        }
      }
    };
    visit(SRC_ROOT);
    assert.deepEqual(offenders, [path.join("execution", "fatal-guard.ts")]);
  });
});
