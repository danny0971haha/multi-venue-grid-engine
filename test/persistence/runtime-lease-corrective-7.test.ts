import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { makeScopeKey } from "../../src/domain/ids.js";
import type { LeaseAuthority, LeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  heartbeatRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { SCOPE_KEY } from "../execution/helpers.js";

const T0_MS = 1_000_000n;
// Both inside the first lease window (T0 + LEASE_TTL_MS), so an old record alone still looks current.
const LATER_MS = 1_010_000n;
const USE_MS = 1_011_000n;
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
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr7-"));
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

async function removeAllFiles(directory: string): Promise<void> {
  for (const relative of (await snapshot(directory)).keys()) {
    await rm(path.join(directory, relative));
  }
  assert.equal((await snapshot(directory)).size, 0);
}

// An external rollback of the whole lease directory to earlier bytes.
async function rollBack(directory: string, earlier: Map<string, string>): Promise<void> {
  await removeAllFiles(directory);
  for (const [relative, bytes] of earlier) {
    await writeFile(path.join(directory, relative), Buffer.from(bytes, "base64"));
  }
  assert.deepEqual(await snapshot(directory), earlier);
}

function acquire(
  directory: string,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
  scopeKey: string = SCOPE_KEY,
) {
  return acquireRuntimeLease({
    directory,
    scopeKey,
    ownerId: "ownerA",
    processInstanceId: "procA",
    latch,
    clock,
  });
}

async function acquireOk(
  directory: string,
  clock: LeaseClock,
  scopeKey: string = SCOPE_KEY,
): Promise<LeaseAuthority> {
  const result = await acquire(directory, clock, new RuntimePersistenceLatch(), scopeKey);
  assert.equal(result.disposition, "ACQUIRED");
  assert.ok(result.authority);
  return result.authority;
}

async function heartbeatOk(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
): Promise<LeaseAuthority> {
  const result = await heartbeatRuntimeLease({
    directory,
    scopeKey: authority.scopeKey,
    authority,
    latch: new RuntimePersistenceLatch(),
    clock,
  });
  assert.equal(result.disposition, "HEARTBEAT_COMMITTED");
  assert.ok(result.authority);
  return result.authority;
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

type Target = {
  name: string;
  // Returns a directory where the pair is BOTH_ABSENT with no witness log.
  prepare(root: string, leaseDirectory: string): Promise<string>;
};

const SIBLING_DIRECTORY: Target = {
  name: "a fresh sibling directory",
  prepare: (root) => freshDirectory(root, "second"),
};

const TARGETS: Target[] = [
  SIBLING_DIRECTORY,
  {
    name: "the same directory after its files are deleted",
    prepare: async (_root, leaseDirectory) => {
      await removeAllFiles(leaseDirectory);
      return leaseDirectory;
    },
  },
];

type Instants = { name: string; heartbeatMs: bigint; initializeMs: bigint };

// Same instant: the second initialization writes bytes identical to the first lease.
const SAME_INSTANT: Instants = {
  name: "at the acquisition instant",
  heartbeatMs: T0_MS,
  initializeMs: T0_MS,
};

const INSTANTS: Instants[] = [
  SAME_INSTANT,
  { name: "at a later instant", heartbeatMs: LATER_MS, initializeMs: LATER_MS },
];

type Spelling = { name: string; spell(directory: string, root: string): Promise<string> };

const SPELLINGS: Spelling[] = [
  { name: "the original spelling", spell: async (directory) => directory },
  { name: "a trailing /.", spell: async (directory) => `${directory}/.` },
  { name: "a trailing separator", spell: async (directory) => `${directory}/` },
  { name: "a relative path", spell: async (directory) => path.relative(process.cwd(), directory) },
  {
    name: "a symlink to the directory",
    spell: async (directory, root) => {
      const link = path.join(root, "link");
      await symlink(directory, link, "dir");
      return link;
    },
  },
];

// Acquire, heartbeat, then a second first-generation initialization of the same
// scope/owner/process, then a rollback of the lease directory to the pre-heartbeat bytes.
async function initializeAgainThenRollBack(
  root: string,
  target: Target,
  instants: Instants,
  clock: SteppedClock,
) {
  const lease = await freshDirectory(root, "lease");
  const original = await acquireOk(lease, clock);
  const beforeHeartbeat = await snapshot(lease);
  clock.set(instants.heartbeatMs);
  await heartbeatOk(lease, original, clock);

  const second = await target.prepare(root, lease);
  clock.set(instants.initializeMs);
  const latch = new RuntimePersistenceLatch();
  const reinitialized = await acquire(second, clock, latch);
  const secondBytes = await snapshot(second);

  await rollBack(lease, beforeHeartbeat);
  return { lease, original, reinitialized, latch, secondBytes };
}

describe("Gate 2 re-review RC6: a fresh initialization cannot rewrite this process's lease history", {
  concurrency: 1,
}, () => {
  for (const target of TARGETS) {
    for (const instants of INSTANTS) {
      test(`RC6-01 initialization in ${target.name} ${instants.name}: the rolled-back token sends nothing`, async () => {
        await withRoot(async (root) => {
          const clock = steppedClock(T0_MS);
          const run = await initializeAgainThenRollBack(root, target, instants, clock);
          const rolledBack = await snapshot(run.lease);

          clock.set(USE_MS);
          const sent = await send(run.lease, run.original, clock);
          assert.equal(sent.result.outcome, "NOT_SENT");
          assert.equal(sent.calls, 0);
          assert.equal(sent.result.callbackCount, 0);
          assert.ok(sent.result.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
          assert.equal(sent.latch.blocked, true);
          assert.deepEqual(await snapshot(run.lease), rolledBack);

          // The conflicting initialization was refused before it wrote anything.
          assert.equal(run.reinitialized.disposition, "AUTHORITY_UNPROVEN");
          assert.equal(run.reinitialized.authority, null);
          assert.equal(run.reinitialized.allowRiskIncrease, false);
          assert.ok(run.reinitialized.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
          assert.ok(run.reinitialized.reasonCodes.includes("LEASE_AUTHORITY_UNPROVEN"));
          assert.equal(run.latch.blocked, true);
          assert.equal(run.secondBytes.size, 0);
        });
      });
    }
  }

  for (const spelling of SPELLINGS.slice(1)) {
    test(`RC6-02 the same-instant rollback stays blocked when the token is used via ${spelling.name}`, async () => {
      await withRoot(async (root) => {
        const clock = steppedClock(T0_MS);
        const run = await initializeAgainThenRollBack(root, SIBLING_DIRECTORY, SAME_INSTANT, clock);
        const spelled = await spelling.spell(run.lease, root);
        assert.notEqual(spelled, run.lease);
        assert.equal(await realpath(spelled), await realpath(run.lease));
        const rolledBack = await snapshot(run.lease);

        clock.set(USE_MS);
        const sent = await send(spelled, run.original, clock);
        assert.equal(sent.result.outcome, "NOT_SENT");
        assert.equal(sent.calls, 0);
        assert.ok(sent.result.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
        assert.equal(sent.latch.blocked, true);
        assert.deepEqual(await snapshot(run.lease), rolledBack);
      });
    });
  }

  test("RC6-03 a second initialization through an alias of the second directory is refused too", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const lease = await freshDirectory(root, "lease");
      await heartbeatOk(lease, await acquireOk(lease, clock), clock);
      const second = await freshDirectory(root, "second");
      const link = path.join(root, "second-link");
      await symlink(second, link, "dir");

      for (const spelled of [link, `${second}/.`, second]) {
        const latch = new RuntimePersistenceLatch();
        const refused = await acquire(spelled, clock, latch);
        assert.equal(refused.disposition, "AUTHORITY_UNPROVEN");
        assert.ok(refused.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
        assert.equal(latch.blocked, true);
        assert.equal((await snapshot(second)).size, 0);
      }
    });
  });

  for (const instants of INSTANTS) {
    test(`RC6-04 control ${instants.name}: the refused initialization leaves the current heartbeat token working`, async () => {
      await withRoot(async (root) => {
        const clock = steppedClock(T0_MS);
        const lease = await freshDirectory(root, "lease");
        const original = await acquireOk(lease, clock);
        clock.set(instants.heartbeatMs);
        const current = await heartbeatOk(lease, original, clock);

        clock.set(instants.initializeMs);
        const refused = await acquire(await freshDirectory(root, "second"), clock);
        assert.equal(refused.disposition, "AUTHORITY_UNPROVEN");

        clock.set(USE_MS);
        const sent = await send(lease, current, clock);
        assert.equal(sent.result.outcome, "SENT");
        assert.equal(sent.calls, 1);
        assert.equal(sent.latch.blocked, false);

        const next = await heartbeatOk(lease, current, clock);
        const afterNext = await send(lease, next, clock);
        assert.equal(afterNext.result.outcome, "SENT");
        assert.equal(afterNext.calls, 1);
      });
    });
  }

  test("RC6-05 control: an independent scope still initializes and sends for the same owner and process", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const lease = await freshDirectory(root, "lease");
      const current = await heartbeatOk(lease, await acquireOk(lease, clock), clock);

      const other = await acquireOk(
        await freshDirectory(root, "other-scope"),
        clock,
        OTHER_SCOPE_KEY,
      );
      assert.equal(other.generation, "1");
      clock.set(USE_MS);
      const otherSent = await send(path.join(root, "other-scope"), other, clock);
      assert.equal(otherSent.result.outcome, "SENT");
      assert.equal(otherSent.calls, 1);

      const leaseSent = await send(lease, current, clock);
      assert.equal(leaseSent.result.outcome, "SENT");
      assert.equal(leaseSent.calls, 1);
    });
  });

  test("RC6-06 control: without a second initialization the rollback is still diverged", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const lease = await freshDirectory(root, "lease");
      const original = await acquireOk(lease, clock);
      const beforeHeartbeat = await snapshot(lease);
      await heartbeatOk(lease, original, clock);
      await rollBack(lease, beforeHeartbeat);

      clock.set(USE_MS);
      const sent = await send(lease, original, clock);
      assert.equal(sent.result.outcome, "NOT_SENT");
      assert.equal(sent.calls, 0);
      assert.ok(sent.result.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
      assert.equal(sent.latch.blocked, true);
    });
  });
});
