import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import fsPromises, {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { makeScopeKey } from "../../src/domain/ids.js";
import { LEASE_WITNESS_FILE_NAME } from "../../src/persistence/lease-witness.js";
import type {
  LeaseAuthority,
  LeaseClock,
  LeaseDisposition,
  LeaseResult,
} from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  heartbeatRuntimeLease,
  LEASE_TTL_MS,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SCOPE_KEY } from "../execution/helpers.js";

const T0_MS = 1_000_000n;
// All inside the lease window that starts at T0, so an old record alone still looks current.
const HEARTBEAT_MS = 1_005_000n;
const LATER_MS = 1_010_000n;
const USE_MS = 1_011_000n;
// PHASE_2C §8: nowMs >= expiresAtMs is expired, so a lease acquired at T0 is expired here.
const EXPIRED_MS = T0_MS + LEASE_TTL_MS;
const OTHER_SCOPE_KEY = makeScopeKey("canary-02", "sim", "BTC_USDC_PERP", "grid-v0.1");

type SteppedClock = LeaseClock & { set(nowMs: bigint): void };

function steppedClock(initialMs: bigint): SteppedClock {
  let current = initialMs;
  return {
    nowMs() {
      return current;
    },
    set(nowMs: bigint) {
      // The scenarios here never need a clock regression.
      assert.ok(nowMs >= current);
      current = nowMs;
    },
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr8-"));
  try {
    await run(root);
  } finally {
    resetLeaseProcessStateForTests();
    await rm(root, { recursive: true, force: true });
  }
}

async function freshDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory);
  return directory;
}

async function snapshot(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files.set(path.relative(directory, full), (await readFile(full)).toString("base64"));
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

// Replaces every file in the directory with the given bytes: an external rollback,
// or a byte copy of another lease directory.
async function restoreBytes(directory: string, bytes: Map<string, string>): Promise<void> {
  for (const relative of (await snapshot(directory)).keys()) {
    await rm(path.join(directory, relative));
  }
  for (const [relative, content] of bytes) {
    await writeFile(path.join(directory, relative), Buffer.from(content, "base64"));
  }
  assert.deepEqual(await snapshot(directory), bytes);
}

async function copyDirectory(source: string, root: string, name: string): Promise<string> {
  const target = await freshDirectory(root, name);
  await restoreBytes(target, await snapshot(source));
  return target;
}

function acquire(
  directory: string,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
  scopeKey: string = SCOPE_KEY,
  processInstanceId = "procA",
) {
  return acquireRuntimeLease({
    directory,
    scopeKey,
    ownerId: processInstanceId === "procA" ? "ownerA" : `owner-${processInstanceId}`,
    processInstanceId,
    latch,
    clock,
  });
}

function heartbeat(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
) {
  return heartbeatRuntimeLease({
    directory,
    scopeKey: authority.scopeKey,
    authority,
    latch,
    clock,
  });
}

async function send(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
) {
  let calls = 0;
  const result = await runLeaseFencedMutation({
    directory,
    scopeKey: authority.scopeKey,
    authority,
    latch,
    clock,
    mutation: () => {
      calls += 1;
      return "sent";
    },
  });
  return { result, calls, latch };
}

type Sent = Awaited<ReturnType<typeof send>>;

function replaceOpen(next: typeof fsPromises.open): void {
  fsPromises.open = next;
  // The lease witness module binds `open` as a named ESM import of node:fs/promises.
  syncBuiltinESMExports();
}

type WitnessAppendGate = {
  arrived: Promise<void>;
  release(): void;
  fail(): void;
  restore(): void;
};

// Parks the first append-mode open of the directory's witness log until release() or
// fail(). For a lease commit that is the PREPARE append, which follows every history
// and pair check of the operation, so the operation is in flight between them.
function holdWitnessAppend(directory: string): WitnessAppendGate {
  const witnessPath = path.resolve(directory, LEASE_WITNESS_FILE_NAME);
  const realOpen = fsPromises.open;
  const arrived = Promise.withResolvers<void>();
  const decision = Promise.withResolvers<"proceed" | "fail">();
  let armed = true;
  replaceOpen(async (file, flags, mode) => {
    if (
      armed &&
      typeof file === "string" &&
      typeof flags === "number" &&
      (flags & fsConstants.O_APPEND) !== 0 &&
      path.resolve(file) === witnessPath
    ) {
      armed = false;
      arrived.resolve();
      if ((await decision.promise) === "fail") {
        throw Object.assign(new Error("injected witness append failure"), { code: "EIO" });
      }
    }
    return realOpen(file, flags, mode);
  });
  return {
    arrived: arrived.promise,
    release: () => decision.resolve("proceed"),
    fail: () => decision.resolve("fail"),
    restore: () => {
      decision.resolve("proceed");
      replaceOpen(realOpen);
    },
  };
}

async function reachesWitnessAppend(
  gate: WitnessAppendGate,
  operation: Promise<LeaseResult>,
): Promise<void> {
  const reached = await Promise.race([gate.arrived.then(() => true), operation.then(() => false)]);
  assert.ok(reached, "the held operation must reach its witness append");
}

function assertRefusedAsInFlight(result: LeaseResult, latch: RuntimePersistenceLatch): void {
  assert.equal(result.disposition, "AUTHORITY_UNPROVEN");
  assert.equal(result.authority, null);
  assert.equal(result.allowRiskIncrease, false);
  assert.ok(result.reasonCodes.includes("COORDINATION_LOCK_HELD"));
  assert.ok(result.reasonCodes.includes("LEASE_AUTHORITY_UNPROVEN"));
  assert.equal(latch.blocked, true);
}

type RaceSetup = {
  clock: SteppedClock;
  // The contending operation runs here; it starts while the held one is in flight.
  directoryA: string;
  // The held operation runs here.
  directoryB: string;
  held(latch: RuntimePersistenceLatch): Promise<LeaseResult>;
  contend(latch: RuntimePersistenceLatch): Promise<LeaseResult>;
  heldDisposition: LeaseDisposition;
  followUpMs: bigint;
  useMs: bigint;
};

type Race = { id: string; name: string; setup(root: string): Promise<RaceSetup> };

const RACES: Race[] = [
  {
    id: "RC7-01",
    name: "two first-generation initializations in different directories",
    setup: async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const directoryB = await freshDirectory(root, "b");
      return {
        clock,
        directoryA,
        directoryB,
        held: (latch) => acquire(directoryB, clock, latch),
        contend: (latch) => acquire(directoryA, clock, latch),
        heldDisposition: "ACQUIRED",
        followUpMs: LATER_MS,
        useMs: USE_MS,
      };
    },
  },
  {
    id: "RC7-02",
    name: "two takeovers of byte copies of one expired lease",
    setup: async (root) => {
      const clock = steppedClock(T0_MS);
      const seed = await freshDirectory(root, "seed");
      const seeded = await acquire(seed, clock, new RuntimePersistenceLatch(), SCOPE_KEY, "procB");
      assert.equal(seeded.disposition, "ACQUIRED");
      const directoryA = await copyDirectory(seed, root, "a");
      const directoryB = await copyDirectory(seed, root, "b");
      clock.set(EXPIRED_MS);
      return {
        clock,
        directoryA,
        directoryB,
        held: (latch) => acquire(directoryB, clock, latch),
        contend: (latch) => acquire(directoryA, clock, latch),
        heldDisposition: "ACQUIRED",
        followUpMs: EXPIRED_MS + 10_000n,
        useMs: EXPIRED_MS + 11_000n,
      };
    },
  },
  {
    id: "RC7-03",
    name: "two heartbeats of byte copies of one current lease",
    setup: async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const acquired = await acquire(directoryA, clock);
      assert.ok(acquired.authority);
      const token = acquired.authority;
      const directoryB = await copyDirectory(directoryA, root, "b");
      clock.set(HEARTBEAT_MS);
      return {
        clock,
        directoryA,
        directoryB,
        held: (latch) => heartbeat(directoryB, token, clock, latch),
        contend: (latch) => heartbeat(directoryA, token, clock, latch),
        heldDisposition: "HEARTBEAT_COMMITTED",
        followUpMs: LATER_MS,
        useMs: USE_MS,
      };
    },
  },
];

type Order = { name: string; heldCompletesFirst: boolean };

const ORDERS: Order[] = [
  // The re-review sequence: the held operation lands after the contender's next heartbeat.
  {
    name: "the held operation completes after the contender's heartbeat",
    heldCompletesFirst: false,
  },
  {
    name: "the held operation completes before the contender's heartbeat",
    heldCompletesFirst: true,
  },
];

type LatchCase = "original" | "fresh";

const LATCH_CASES: LatchCase[] = ["original", "fresh"];

type RaceRun = {
  heldDisposition: LeaseDisposition;
  untouchedA: Map<string, string>;
  contended: LeaseResult;
  contendedBytes: Map<string, string>;
  latchA: RuntimePersistenceLatch;
  staleContended: Sent | null;
  held: LeaseResult;
  current: LeaseResult | null;
  currentSent: Sent | null;
  staleHeld: Sent | null;
};

// One process, one scope and one process instance, two lease directories. The held
// operation has passed its checks and is in flight when the contender starts. Every
// token either side obtains is later used after its directory is rolled back to the
// bytes it was issued with, once a later commit exists. No process memory is reset.
async function runRace(root: string, race: Race, order: Order, latchCase: LatchCase) {
  const setup = await race.setup(root);
  const { clock } = setup;
  const latchA = new RuntimePersistenceLatch();
  const latchB = new RuntimePersistenceLatch();
  const pick = (original: RuntimePersistenceLatch) =>
    latchCase === "original" ? original : new RuntimePersistenceLatch();
  const untouchedA = await snapshot(setup.directoryA);

  const gate = holdWitnessAppend(setup.directoryB);
  const pending = setup.held(latchB);
  let contended: LeaseResult;
  let contendedBytes: Map<string, string>;
  try {
    await reachesWitnessAppend(gate, pending);
    contended = await setup.contend(latchA);
    contendedBytes = await snapshot(setup.directoryA);
    if (order.heldCompletesFirst) {
      gate.release();
      await pending;
    }
    if (contended.authority !== null) {
      clock.set(setup.followUpMs);
      await heartbeat(setup.directoryA, contended.authority, clock, latchA);
    }
    gate.release();
  } finally {
    gate.restore();
    await pending;
  }
  const held = await pending;

  let staleContended: Sent | null = null;
  if (contended.authority !== null) {
    await restoreBytes(setup.directoryA, contendedBytes);
    clock.set(setup.useMs);
    staleContended = await send(setup.directoryA, contended.authority, clock, pick(latchA));
  }

  const run: RaceRun = {
    heldDisposition: setup.heldDisposition,
    untouchedA,
    contended,
    contendedBytes,
    latchA,
    staleContended,
    held,
    current: null,
    currentSent: null,
    staleHeld: null,
  };
  if (held.authority === null) {
    return run;
  }
  clock.set(setup.useMs);
  const heldBytes = await snapshot(setup.directoryB);
  run.current = await heartbeat(setup.directoryB, held.authority, clock, latchB);
  if (run.current.authority !== null) {
    run.currentSent = await send(setup.directoryB, run.current.authority, clock, latchB);
  }
  await restoreBytes(setup.directoryB, heldBytes);
  run.staleHeld = await send(setup.directoryB, held.authority, clock, pick(latchB));
  return run;
}

function assertNothingSent(sent: Sent): void {
  assert.equal(sent.result.outcome, "NOT_SENT");
  assert.equal(sent.calls, 0);
  assert.equal(sent.result.callbackCount, 0);
}

type Spelling = { name: string; spell(directory: string, root: string): Promise<string> };

const SAME_DIRECTORY_SPELLINGS: Spelling[] = [
  { name: "the same spelling", spell: async (directory) => directory },
  { name: "a trailing /.", spell: async (directory) => `${directory}/.` },
  {
    name: "a symlink to the directory",
    spell: async (directory, root) => {
      const link = path.join(root, "link");
      await symlink(directory, link, "dir");
      return link;
    },
  },
];

describe("Gate 2 re-review RC7: an in-flight lease operation cannot overwrite a later commit in this process's history", {
  concurrency: 1,
}, () => {
  for (const race of RACES) {
    for (const order of ORDERS) {
      for (const latchCase of LATCH_CASES) {
        test(`${race.id} ${race.name}, ${order.name}, ${latchCase} latch: no stale token sends`, async () => {
          await withRoot(async (root) => {
            const run = await runRace(root, race, order, latchCase);

            // Zero stale-token callbacks, whichever side obtained a token.
            if (run.staleContended !== null) {
              assertNothingSent(run.staleContended);
            }
            assert.ok(run.staleHeld);
            assertNothingSent(run.staleHeld);

            // The contender is refused while the held operation is in flight, before it
            // writes anything, and its latch stays blocked.
            assertRefusedAsInFlight(run.contended, run.latchA);
            assert.equal(run.staleContended, null);
            assert.deepEqual(run.contendedBytes, run.untouchedA);

            // The held operation completes, and its current token keeps working.
            assert.equal(run.held.disposition, run.heldDisposition);
            assert.ok(run.current);
            assert.equal(run.current.disposition, "HEARTBEAT_COMMITTED");
            assert.ok(run.currentSent);
            assert.equal(run.currentSent.result.outcome, "SENT");
            assert.equal(run.currentSent.calls, 1);
          });
        });
      }
    }
  }

  test("RC7-04 control: an independent scope initializes and sends while another scope's initialization is in flight", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const directoryB = await freshDirectory(root, "b");
      const gate = holdWitnessAppend(directoryB);
      const pending = acquire(directoryB, clock);
      let other: LeaseResult;
      try {
        await reachesWitnessAppend(gate, pending);
        other = await acquire(directoryA, clock, new RuntimePersistenceLatch(), OTHER_SCOPE_KEY);
        gate.release();
      } finally {
        gate.restore();
        await pending;
      }
      const held = await pending;

      assert.equal(other.disposition, "ACQUIRED");
      assert.ok(other.authority);
      assert.equal(held.disposition, "ACQUIRED");
      assert.ok(held.authority);
      clock.set(USE_MS);
      for (const [directory, authority] of [
        [directoryA, other.authority],
        [directoryB, held.authority],
      ] as const) {
        const sent = await send(directory, authority, clock);
        assert.equal(sent.result.outcome, "SENT");
        assert.equal(sent.calls, 1);
      }
    });
  });

  test("RC7-05 control: another process instance initializes the same scope in another directory meanwhile", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const directoryB = await freshDirectory(root, "b");
      const gate = holdWitnessAppend(directoryB);
      const pending = acquire(directoryB, clock);
      let other: LeaseResult;
      try {
        await reachesWitnessAppend(gate, pending);
        other = await acquire(directoryA, clock, new RuntimePersistenceLatch(), SCOPE_KEY, "procC");
        gate.release();
      } finally {
        gate.restore();
        await pending;
      }
      const held = await pending;

      assert.equal(other.disposition, "ACQUIRED");
      assert.ok(other.authority);
      assert.equal(held.disposition, "ACQUIRED");
      assert.ok(held.authority);
      clock.set(USE_MS);
      for (const [directory, authority] of [
        [directoryA, other.authority],
        [directoryB, held.authority],
      ] as const) {
        const sent = await send(directory, authority, clock);
        assert.equal(sent.result.outcome, "SENT");
        assert.equal(sent.calls, 1);
      }
    });
  });

  for (const spelling of SAME_DIRECTORY_SPELLINGS) {
    test(`RC7-06 control: a second acquisition through ${spelling.name} waits on the directory guard instead of being refused as in flight`, async () => {
      await withRoot(async (root) => {
        const clock = steppedClock(T0_MS);
        const lease = await freshDirectory(root, "lease");
        const spelled = await spelling.spell(lease, root);
        const latch = new RuntimePersistenceLatch();
        const gate = holdWitnessAppend(lease);
        const first = acquire(lease, clock);
        let second: Promise<LeaseResult> | undefined;
        try {
          await reachesWitnessAppend(gate, first);
          second = acquire(spelled, clock, latch);
          const settledEarly = await Promise.race([
            second.then(() => true),
            delay(100).then(() => false),
          ]);
          assert.equal(settledEarly, false);
          gate.release();
        } finally {
          gate.restore();
          await first;
          await second;
        }
        const acquired = await first;
        const repeated = await second;

        assert.equal(acquired.disposition, "ACQUIRED");
        assert.ok(acquired.authority);
        // Exactly what a sequential second acquisition of a current lease returns.
        assert.equal(repeated.disposition, "BLOCKED");
        assert.ok(repeated.reasonCodes.includes("LEASE_NOT_EXPIRED"));
        assert.ok(!repeated.reasonCodes.includes("COORDINATION_LOCK_HELD"));
        assert.equal(latch.blocked, false);

        clock.set(USE_MS);
        const sent = await send(lease, acquired.authority, clock);
        assert.equal(sent.result.outcome, "SENT");
        assert.equal(sent.calls, 1);
      });
    });
  }

  test("RC7-07 control: a failed in-flight initialization leaves nothing behind that refuses the next one", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const directoryB = await freshDirectory(root, "b");
      const gate = holdWitnessAppend(directoryB);
      const pending = acquire(directoryB, clock);
      try {
        await reachesWitnessAppend(gate, pending);
        gate.fail();
      } finally {
        gate.restore();
        await pending;
      }
      const failed = await pending;
      assert.equal(failed.authority, null);
      assert.ok(failed.reasonCodes.includes("WITNESS_IO_FAILURE"));

      const latch = new RuntimePersistenceLatch();
      const next = await acquire(directoryA, clock, latch);
      assert.equal(next.disposition, "ACQUIRED");
      assert.ok(next.authority);
      assert.equal(latch.blocked, false);
      clock.set(USE_MS);
      const sent = await send(directoryA, next.authority, clock);
      assert.equal(sent.result.outcome, "SENT");
      assert.equal(sent.calls, 1);
    });
  });
});
