import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { makeScopeKey } from "../../src/domain/ids.js";
import { createLeaseMutationFence } from "../../src/execution/lease-fence.js";
import type { LeaseAuthority, LeaseClock } from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  assertCurrentLease,
  heartbeatRuntimeLease,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { buildIntent, createHarness, grant, SCOPE_KEY } from "../execution/helpers.js";

const ACQUIRED_AT_MS = 1_000_000n;
// Exactly acquiredAt + LEASE_TTL_MS: PHASE_2C §8 treats nowMs >= expiresAtMs as expired.
const EXACT_EXPIRY_MS = 1_030_000n;
// Inside the original lease window, so the durable record alone would still look current.
const RETURNED_MS = 1_001_000n;
const HEARTBEAT_MS = 1_010_000n;

type MutableClock = LeaseClock & { set(nowMs: bigint): void };

function mutableClock(initialMs: bigint): MutableClock {
  let current = initialMs;
  return {
    nowMs() {
      return current;
    },
    set(nowMs: bigint) {
      current = nowMs;
    },
  };
}

// The lease directory is `<root>/lease`; aliases and copies are made elsewhere under `root`,
// so they never add entries to the lease directory itself.
async function withLeaseRoot(
  run: (directory: string, root: string) => Promise<void>,
): Promise<void> {
  resetLeaseProcessStateForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr6-"));
  const directory = path.join(root, "lease");
  await mkdir(directory);
  try {
    await run(directory, root);
  } finally {
    resetLeaseProcessStateForTests();
    await rm(root, { recursive: true, force: true });
  }
}

type Alias = { name: string; spell(directory: string, root: string): Promise<string> };

// Other spellings of the same host-local directory. Symlink aliases are supported: they reach
// the same pair, witness and coordination lock, so they must share the same fence.
const ALIASES: Alias[] = [
  { name: "trailing /.", spell: async (directory) => `${directory}/.` },
  { name: "trailing separator", spell: async (directory) => `${directory}/` },
  {
    name: "doubled separator",
    spell: async (directory) => `${path.dirname(directory)}//${path.basename(directory)}`,
  },
  {
    name: "dot-dot segment",
    spell: async (directory, root) => {
      await mkdir(path.join(root, "nested"));
      return `${root}/nested/../${path.basename(directory)}`;
    },
  },
  { name: "relative path", spell: async (directory) => path.relative(process.cwd(), directory) },
  {
    name: "symlink to the directory",
    spell: async (directory, root) => {
      const link = path.join(root, "lease-link");
      await symlink(directory, link, "dir");
      return link;
    },
  },
  {
    name: "symlinked parent",
    spell: async (directory, root) => {
      const link = path.join(root, "parent-link");
      await symlink(root, link, "dir");
      return path.join(link, path.basename(directory));
    },
  },
];

async function spellAlias(alias: Alias, directory: string, root: string): Promise<string> {
  const spelled = await alias.spell(directory, root);
  assert.notEqual(spelled, directory);
  assert.equal(await realpath(spelled), await realpath(directory));
  const [aliasStat, directoryStat] = [await stat(spelled), await stat(directory)];
  assert.equal(aliasStat.dev, directoryStat.dev);
  assert.equal(aliasStat.ino, directoryStat.ino);
  return spelled;
}

async function acquireAs(
  directory: string,
  clock: LeaseClock,
  ownerId = "ownerA",
  processInstanceId = "procA",
  scopeKey: string = SCOPE_KEY,
): Promise<LeaseAuthority> {
  const acquired = await acquireRuntimeLease({
    directory,
    scopeKey,
    ownerId,
    processInstanceId,
    latch: new RuntimePersistenceLatch(),
    clock,
  });
  assert.equal(acquired.disposition, "ACQUIRED");
  assert.ok(acquired.authority);
  return acquired.authority;
}

// Every file under the lease directory with its bytes, so a failed operation can be shown
// to have written nothing.
async function directoryBytes(directory: string): Promise<Map<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (entry.isFile()) {
      const full = path.join(entry.parentPath, entry.name);
      files.set(path.relative(directory, full), (await readFile(full)).toString("base64"));
    }
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

// Rewrites the lease directory to an earlier byte snapshot: an external rollback that leaves
// a self-consistent older pair and witness log.
async function restoreDirectoryBytes(
  directory: string,
  snapshot: Map<string, string>,
): Promise<void> {
  for (const relative of (await directoryBytes(directory)).keys()) {
    if (!snapshot.has(relative)) {
      await rm(path.join(directory, relative));
    }
  }
  for (const [relative, bytes] of snapshot) {
    await writeFile(path.join(directory, relative), Buffer.from(bytes, "base64"));
  }
  assert.deepEqual(await directoryBytes(directory), snapshot);
}

async function mutate(
  directory: string,
  authority: LeaseAuthority,
  latch: RuntimePersistenceLatch,
  clock: LeaseClock,
  scopeKey: string = SCOPE_KEY,
) {
  let calls = 0;
  const result = await runLeaseFencedMutation({
    directory,
    scopeKey,
    authority,
    latch,
    clock,
    mutation: () => {
      calls += 1;
      return "sent";
    },
  });
  return { result, calls };
}

async function failAtExactExpiry(
  check: "heartbeat" | "assert",
  lease: {
    directory: string;
    scopeKey: string;
    authority: LeaseAuthority;
    latch: RuntimePersistenceLatch;
    clock: MutableClock;
  },
): Promise<void> {
  lease.clock.set(EXACT_EXPIRY_MS);
  const failed =
    check === "heartbeat" ? await heartbeatRuntimeLease(lease) : await assertCurrentLease(lease);
  assert.equal(failed.disposition, "BLOCKED");
  assert.equal(failed.authority, null);
  assert.ok(failed.reasonCodes.includes("LEASE_EXPIRED"));
  // Only a failed heartbeat blocks its latch; a failed assertion fences the token only.
  assert.equal(lease.latch.blocked, check === "heartbeat");
}

describe("Gate 2 re-review RC5: lease identity across directory spellings", {
  concurrency: 1,
}, () => {
  for (const alias of ALIASES) {
    for (const check of ["heartbeat", "assert"] as const) {
      for (const order of ["original then alias", "alias then original"] as const) {
        test(`RC5-01 ${check} at exact expiry, clock return, ${alias.name} (${order}): nothing sent, no revival`, async () => {
          await withLeaseRoot(async (directory, root) => {
            const spelled = await spellAlias(alias, directory, root);
            const [fenceDirectory, useDirectory] =
              order === "original then alias" ? [directory, spelled] : [spelled, directory];
            const clock = mutableClock(ACQUIRED_AT_MS);
            const authority = await acquireAs(fenceDirectory, clock);
            const latch = new RuntimePersistenceLatch();
            const before = await directoryBytes(directory);

            await failAtExactExpiry(check, {
              directory: fenceDirectory,
              scopeKey: SCOPE_KEY,
              authority,
              latch,
              clock,
            });

            clock.set(RETURNED_MS);
            const sameLatch = await mutate(useDirectory, authority, latch, clock);
            assert.equal(sameLatch.result.outcome, "NOT_SENT");
            assert.equal(sameLatch.calls, 0);
            assert.equal(sameLatch.result.callbackCount, 0);
            assert.ok(sameLatch.result.reasonCodes.includes("MUTATION_NOT_SENT"));

            const freshLatch = await mutate(
              useDirectory,
              authority,
              new RuntimePersistenceLatch(),
              clock,
            );
            assert.equal(freshLatch.result.outcome, "NOT_SENT");
            assert.equal(freshLatch.calls, 0);
            assert.equal(freshLatch.result.callbackCount, 0);
            assert.ok(freshLatch.result.reasonCodes.includes("FENCED_OWNER"));

            const use = { directory: useDirectory, scopeKey: SCOPE_KEY, authority, clock };
            const heartbeatLatch = new RuntimePersistenceLatch();
            const heartbeat = await heartbeatRuntimeLease({ ...use, latch: heartbeatLatch });
            assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
            assert.equal(heartbeat.authority, null);
            assert.ok(heartbeat.reasonCodes.includes("FENCED_OWNER"));
            assert.equal(heartbeatLatch.blocked, true);

            const asserted = await assertCurrentLease({
              ...use,
              latch: new RuntimePersistenceLatch(),
            });
            assert.notEqual(asserted.disposition, "ACQUIRED");
            assert.equal(asserted.authority, null);
            assert.ok(asserted.reasonCodes.includes("FENCED_OWNER"));

            const released = await releaseRuntimeLease({
              ...use,
              latch: new RuntimePersistenceLatch(),
            });
            assert.equal(released.disposition, "BLOCKED");
            assert.ok(released.reasonCodes.includes("FENCED_OWNER"));

            assert.deepEqual(await directoryBytes(directory), before);
          });
        });
      }
    }
  }

  for (const alias of ALIASES) {
    for (const check of ["heartbeat", "assert"] as const) {
      for (const fenceLatch of ["the same latch", "its own latch"] as const) {
        test(`RC5-02 Phase 3 fences built before a failed ${check}, ${alias.name}, ${fenceLatch}: NOT_SENT, no place`, async () => {
          await withLeaseRoot(async (directory, root) => {
            const spelled = await spellAlias(alias, directory, root);
            const clock = mutableClock(ACQUIRED_AT_MS);
            const authority = await acquireAs(directory, clock);
            const latch = new RuntimePersistenceLatch();
            // A fence with its own latch can only be denied by the process token fence.
            const latchFor = () =>
              fenceLatch === "the same latch" ? latch : new RuntimePersistenceLatch();
            const viaOriginal = await createHarness({
              fence: createLeaseMutationFence({
                directory,
                scopeKey: SCOPE_KEY,
                authority,
                latch: latchFor(),
                clock,
              }),
            });
            const viaAlias = await createHarness({
              fence: createLeaseMutationFence({
                directory: spelled,
                scopeKey: SCOPE_KEY,
                authority,
                latch: latchFor(),
                clock,
              }),
            });
            const before = await directoryBytes(directory);

            await failAtExactExpiry(check, {
              directory,
              scopeKey: SCOPE_KEY,
              authority,
              latch,
              clock,
            });

            clock.set(RETURNED_MS);
            for (const h of [viaOriginal, viaAlias]) {
              await grant(h.coordinator);
              const submitted = await h.coordinator.submit(
                buildIntent({ leaseGeneration: authority.generation }),
              );
              assert.equal(submitted.record?.status, "NOT_SENT");
              assert.ok(submitted.reasonCodes.includes("FENCE_NOT_SENT"));
              assert.ok(submitted.reasonCodes.includes("MUTATION_NOT_SENT"));
              assert.equal(h.venue.calls.place, 0);
            }
            assert.deepEqual(await directoryBytes(directory), before);
          });
        });
      }
    }
  }

  const spellings: (Alias | null)[] = [null, ...ALIASES];

  for (const alias of spellings) {
    const name = alias === null ? "the original spelling" : alias.name;
    test(`RC5-03 after a rollback to an older generation, acquire via ${name} is a regression`, async () => {
      await withLeaseRoot(async (directory, root) => {
        const spelled = alias === null ? directory : await spellAlias(alias, directory, root);
        const clock = mutableClock(ACQUIRED_AT_MS);
        const first = await acquireAs(directory, clock);
        const released = await releaseRuntimeLease({
          directory,
          scopeKey: SCOPE_KEY,
          authority: first,
          latch: new RuntimePersistenceLatch(),
          clock,
        });
        assert.equal(released.disposition, "RELEASED");
        const older = await directoryBytes(directory);

        const second = await acquireAs(directory, clock, "ownerB", "procB");
        assert.equal(BigInt(second.generation), BigInt(first.generation) + 1n);
        await restoreDirectoryBytes(directory, older);

        const latch = new RuntimePersistenceLatch();
        const rolledBack = await acquireRuntimeLease({
          directory: spelled,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerC",
          processInstanceId: "procC",
          latch,
          clock,
        });
        assert.equal(rolledBack.disposition, "AUTHORITY_UNPROVEN");
        assert.equal(rolledBack.authority, null);
        assert.ok(rolledBack.reasonCodes.includes("LEASE_GENERATION_REGRESSION"));
        assert.equal(latch.blocked, true);
        assert.deepEqual(await directoryBytes(directory), older);
      });
    });
  }

  for (const alias of spellings) {
    const name = alias === null ? "the original spelling" : alias.name;
    test(`RC5-04 after a rollback behind this process's heartbeat, the old token via ${name} is diverged`, async () => {
      await withLeaseRoot(async (directory, root) => {
        const spelled = alias === null ? directory : await spellAlias(alias, directory, root);
        const clock = mutableClock(ACQUIRED_AT_MS);
        const authority = await acquireAs(directory, clock);
        const older = await directoryBytes(directory);

        clock.set(HEARTBEAT_MS);
        const heartbeat = await heartbeatRuntimeLease({
          directory,
          scopeKey: SCOPE_KEY,
          authority,
          latch: new RuntimePersistenceLatch(),
          clock,
        });
        assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
        await restoreDirectoryBytes(directory, older);

        const latch = new RuntimePersistenceLatch();
        const sent = await mutate(spelled, authority, latch, clock);
        assert.equal(sent.result.outcome, "NOT_SENT");
        assert.equal(sent.calls, 0);
        assert.equal(sent.result.callbackCount, 0);
        assert.ok(sent.result.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
        assert.equal(latch.blocked, true);
        assert.deepEqual(await directoryBytes(directory), older);
      });
    });
  }

  test("RC5-05 a byte copy of a fenced lease directory does not revive the token", async () => {
    await withLeaseRoot(async (directory, root) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireAs(directory, clock);
      const latch = new RuntimePersistenceLatch();
      await failAtExactExpiry("assert", {
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch,
        clock,
      });

      const copy = path.join(root, "copy");
      await cp(directory, copy, { recursive: true });
      assert.deepEqual(await directoryBytes(copy), await directoryBytes(directory));
      const before = await directoryBytes(copy);

      clock.set(RETURNED_MS);
      const sent = await mutate(copy, authority, new RuntimePersistenceLatch(), clock);
      assert.equal(sent.result.outcome, "NOT_SENT");
      assert.equal(sent.calls, 0);
      assert.equal(sent.result.callbackCount, 0);
      assert.ok(sent.result.reasonCodes.includes("FENCED_OWNER"));

      const heartbeat = await heartbeatRuntimeLease({
        directory: copy,
        scopeKey: SCOPE_KEY,
        authority,
        latch: new RuntimePersistenceLatch(),
        clock,
      });
      assert.notEqual(heartbeat.disposition, "HEARTBEAT_COMMITTED");
      assert.ok(heartbeat.reasonCodes.includes("FENCED_OWNER"));
      assert.deepEqual(await directoryBytes(copy), before);
    });
  });

  test("RC5-06 process memory is per scope: the same scope in another directory stays fenced, another scope does not", async () => {
    await withLeaseRoot(async (directory, root) => {
      const clock = mutableClock(ACQUIRED_AT_MS);
      const authority = await acquireAs(directory, clock);
      await failAtExactExpiry("assert", {
        directory,
        scopeKey: SCOPE_KEY,
        authority,
        latch: new RuntimePersistenceLatch(),
        clock,
      });
      clock.set(RETURNED_MS);

      // Same scope, owner and process in a fresh directory: the same lease identity, so this
      // process's lease history refuses a new first-generation lease there (Gate 2 RC6), and
      // the fenced token sends nothing there.
      const sameScopeDirectory = path.join(root, "same-scope");
      await mkdir(sameScopeDirectory);
      const sameScopeLatch = new RuntimePersistenceLatch();
      const sameScope = await acquireRuntimeLease({
        directory: sameScopeDirectory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerA",
        processInstanceId: "procA",
        latch: sameScopeLatch,
        clock,
      });
      assert.equal(sameScope.disposition, "AUTHORITY_UNPROVEN");
      assert.equal(sameScope.authority, null);
      assert.ok(sameScope.reasonCodes.includes("LEASE_RECORD_DIVERGED"));
      assert.equal(sameScopeLatch.blocked, true);
      assert.equal((await directoryBytes(sameScopeDirectory)).size, 0);
      const sameScopeSent = await mutate(
        sameScopeDirectory,
        authority,
        new RuntimePersistenceLatch(),
        clock,
      );
      assert.equal(sameScopeSent.result.outcome, "NOT_SENT");
      assert.equal(sameScopeSent.calls, 0);
      assert.ok(sameScopeSent.result.reasonCodes.includes("FENCED_OWNER"));

      const otherScopeKey = makeScopeKey("canary-02", "sim", "BTC_USDC_PERP", "grid-v0.1");
      const otherScopeDirectory = path.join(root, "other-scope");
      await mkdir(otherScopeDirectory);
      const otherScope = await acquireAs(
        otherScopeDirectory,
        clock,
        "ownerA",
        "procA",
        otherScopeKey,
      );
      const otherScopeSent = await mutate(
        otherScopeDirectory,
        otherScope,
        new RuntimePersistenceLatch(),
        clock,
        otherScopeKey,
      );
      assert.equal(otherScopeSent.result.outcome, "SENT");
      assert.equal(otherScopeSent.calls, 1);
    });
  });

  for (const alias of ALIASES) {
    test(`RC5-07 a current token sends via ${alias.name}, and a heartbeat committed there sends via the original`, async () => {
      await withLeaseRoot(async (directory, root) => {
        const spelled = await spellAlias(alias, directory, root);
        const clock = mutableClock(ACQUIRED_AT_MS);
        const authority = await acquireAs(directory, clock);
        const latch = new RuntimePersistenceLatch();

        const viaAlias = await mutate(spelled, authority, latch, clock);
        assert.equal(viaAlias.result.outcome, "SENT");
        assert.equal(viaAlias.calls, 1);

        // The heartbeat via the alias is this process's last commit for the lease, whatever
        // the spelling, so the original spelling does not see it as a diverged record.
        clock.set(HEARTBEAT_MS);
        const heartbeat = await heartbeatRuntimeLease({
          directory: spelled,
          scopeKey: SCOPE_KEY,
          authority,
          latch,
          clock,
        });
        assert.equal(heartbeat.disposition, "HEARTBEAT_COMMITTED");
        assert.ok(heartbeat.authority);

        const viaOriginal = await mutate(directory, heartbeat.authority, latch, clock);
        assert.equal(viaOriginal.result.outcome, "SENT");
        assert.equal(viaOriginal.calls, 1);
        assert.equal(latch.blocked, false);
      });
    });
  }

  for (const alias of ALIASES) {
    test(`RC5-08 control: a second owner via ${alias.name} is refused while the lease is held`, async () => {
      await withLeaseRoot(async (directory, root) => {
        const spelled = await spellAlias(alias, directory, root);
        const clock = mutableClock(ACQUIRED_AT_MS);
        await acquireAs(directory, clock);
        const latch = new RuntimePersistenceLatch();

        clock.set(RETURNED_MS);
        const contender = await acquireRuntimeLease({
          directory: spelled,
          scopeKey: SCOPE_KEY,
          ownerId: "ownerB",
          processInstanceId: "procB",
          latch,
          clock,
        });
        assert.equal(contender.disposition, "BLOCKED");
        assert.equal(contender.authority, null);
        assert.ok(contender.reasonCodes.includes("LEASE_HELD_BY_OTHER"));
        assert.equal(latch.blocked, false);
      });
    });
  }

  const contended = ALIASES.filter(
    (alias) => alias.name === "trailing /." || alias.name === "symlink to the directory",
  );
  for (const alias of contended) {
    test(`RC5-09 control: a mutation via ${alias.name} waits for one in progress via the original`, async () => {
      await withLeaseRoot(async (directory, root) => {
        const spelled = await spellAlias(alias, directory, root);
        const clock = mutableClock(ACQUIRED_AT_MS);
        const authority = await acquireAs(directory, clock);
        const lease = {
          scopeKey: SCOPE_KEY,
          authority,
          latch: new RuntimePersistenceLatch(),
          clock,
        };
        const events: string[] = [];
        let finishFirst = () => {};
        const firstMayFinish = new Promise<void>((resolve) => {
          finishFirst = resolve;
        });

        const first = runLeaseFencedMutation({
          ...lease,
          directory,
          mutation: async () => {
            events.push("first started");
            await firstMayFinish;
            events.push("first finished");
            return "first";
          },
        });
        while (!events.includes("first started")) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const second = runLeaseFencedMutation({
          ...lease,
          directory: spelled,
          mutation: () => {
            events.push("second ran");
            return "second";
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.deepEqual(events, ["first started"]);

        finishFirst();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        assert.equal(firstResult.outcome, "SENT");
        assert.equal(secondResult.outcome, "SENT");
        assert.deepEqual(events, ["first started", "first finished", "second ran"]);
      });
    });
  }
});
