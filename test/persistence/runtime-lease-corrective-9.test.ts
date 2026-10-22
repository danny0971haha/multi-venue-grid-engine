import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import fsPromises, { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import { makeScopeKey } from "../../src/domain/ids.js";
import { createLeaseMutationFence } from "../../src/execution/lease-fence.js";
import { LEASE_WITNESS_FILE_NAME } from "../../src/persistence/lease-witness.js";
import type {
  LeaseAuthority,
  LeaseClock,
  LeaseOperationRequest,
  LeaseResult,
  LeaseTokenRequest,
} from "../../src/persistence/runtime-lease.js";
import {
  acquireRuntimeLease,
  assertCurrentLease,
  heartbeatRuntimeLease,
  LEASE_TTL_MS,
  releaseRuntimeLease,
  resetLeaseProcessStateForTests,
  runLeaseFencedMutation,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";
import { buildIntent, createHarness, grant, SCOPE_KEY } from "../execution/helpers.js";

const T0_MS = 1_000_000n;
// All inside the lease window that starts at T0, so an old record alone still looks current.
const HEARTBEAT_MS = 1_005_000n;
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
  const root = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr9-"));
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

// Replaces every file in the directory with the given bytes: an external rollback.
async function restoreBytes(directory: string, bytes: Map<string, string>): Promise<void> {
  for (const relative of (await snapshot(directory)).keys()) {
    await rm(path.join(directory, relative));
  }
  for (const [relative, content] of bytes) {
    await writeFile(path.join(directory, relative), Buffer.from(content, "base64"));
  }
  assert.deepEqual(await snapshot(directory), bytes);
}

function operationRequest(
  directory: string,
  clock: LeaseClock,
  processInstanceId: string,
  ownerId: string,
  latch = new RuntimePersistenceLatch(),
): LeaseOperationRequest {
  return { directory, scopeKey: SCOPE_KEY, ownerId, processInstanceId, latch, clock };
}

async function acquire(
  directory: string,
  clock: LeaseClock,
  processInstanceId: string,
  ownerId: string,
): Promise<LeaseAuthority> {
  const acquired = await acquireRuntimeLease(
    operationRequest(directory, clock, processInstanceId, ownerId),
  );
  assert.equal(acquired.disposition, "ACQUIRED");
  assert.ok(acquired.authority);
  return acquired.authority;
}

function tokenRequest(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
): LeaseTokenRequest {
  return { directory, scopeKey: authority.scopeKey, authority, latch, clock };
}

async function heartbeat(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
): Promise<LeaseAuthority> {
  const beat = await heartbeatRuntimeLease(tokenRequest(directory, authority, clock));
  assert.equal(beat.disposition, "HEARTBEAT_COMMITTED");
  assert.ok(beat.authority);
  return beat.authority;
}

type Sent = { result: Awaited<ReturnType<typeof runLeaseFencedMutation>>; calls: number };

async function send(
  directory: string,
  authority: LeaseAuthority,
  clock: LeaseClock,
  latch = new RuntimePersistenceLatch(),
): Promise<Sent> {
  let calls = 0;
  const result = await runLeaseFencedMutation({
    ...tokenRequest(directory, authority, clock, latch),
    mutation: () => {
      calls += 1;
      return "sent";
    },
  });
  return { result, calls };
}

function assertNothingSent(sent: Sent): void {
  assert.equal(sent.result.outcome, "NOT_SENT");
  assert.equal(sent.calls, 0);
  assert.equal(sent.result.callbackCount, 0);
}

function assertSentOnce(sent: Sent): void {
  assert.equal(sent.result.outcome, "SENT");
  assert.equal(sent.calls, 1);
  assert.equal(sent.result.callbackCount, 1);
}

function assertIdentity(
  authority: LeaseAuthority | null,
  expected: { scopeKey: string; ownerId: string; processInstanceId: string },
): asserts authority is LeaseAuthority {
  assert.ok(authority);
  assert.equal(authority.scopeKey, expected.scopeKey);
  assert.equal(authority.ownerId, expected.ownerId);
  assert.equal(authority.processInstanceId, expected.processInstanceId);
}

function replaceOpen(next: typeof fsPromises.open): void {
  fsPromises.open = next;
  // The lease witness module binds `open` as a named ESM import of node:fs/promises.
  syncBuiltinESMExports();
}

type WitnessAppendGate = { arrived: Promise<void>; release(): void; restore(): void };

// Parks the first append-mode open of the directory's witness log until release(). For a
// lease commit that is the PREPARE append, which follows every history and pair check of
// the operation, so the operation is in flight, holding its claim, between them.
function holdWitnessAppend(directory: string): WitnessAppendGate {
  const witnessPath = path.resolve(directory, LEASE_WITNESS_FILE_NAME);
  const realOpen = fsPromises.open;
  const arrived = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
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
      await released.promise;
    }
    return realOpen(file, flags, mode);
  });
  return {
    arrived: arrived.promise,
    release: () => released.resolve(),
    restore: () => {
      released.resolve();
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

type Order = { name: string; heldCompletesFirst: boolean };

const ORDERS: Order[] = [
  // The re-review sequence: the held acquisition lands after the other instance's heartbeat.
  { name: "the held acquisition completes after procA's heartbeat", heldCompletesFirst: false },
  { name: "the held acquisition completes before procA's heartbeat", heldCompletesFirst: true },
];

const LATCH_CASES = ["original", "fresh"] as const;

type Race = {
  clock: SteppedClock;
  directoryA: string;
  directoryB: string;
  latchA: RuntimePersistenceLatch;
  latchB: RuntimePersistenceLatch;
};

async function newRace(root: string): Promise<Race> {
  return {
    clock: steppedClock(T0_MS),
    directoryA: await freshDirectory(root, "a"),
    directoryB: await freshDirectory(root, "b"),
    latchA: new RuntimePersistenceLatch(),
    latchB: new RuntimePersistenceLatch(),
  };
}

type RaceOutcome<T> = {
  // procA's first token, the bytes of directory A when it was issued, and its heartbeat token.
  issued: LeaseAuthority;
  issuedBytes: Map<string, string>;
  current: LeaseAuthority;
  // The acquisition of directory B that was held at its witness append.
  held: LeaseResult;
  onIssued: T;
};

// The re-review schedule. An acquisition of empty directory B as procB, whose request names
// procA right after the call, is held at its witness append while procA acquires directory A
// and heartbeats. Same owner and time as procA's lease, so an identity read from the request
// after the guard would produce procA's exact first record.
async function runHeldAcquisition<T>(
  race: Race,
  order: Order,
  onIssued: (issued: LeaseAuthority) => Promise<T>,
): Promise<RaceOutcome<T>> {
  const { clock, directoryA, directoryB, latchA, latchB } = race;
  const requestB = operationRequest(directoryB, clock, "procB", "ownerA", latchB);
  const gate = holdWitnessAppend(directoryB);
  const pending = acquireRuntimeLease(requestB);
  // An ordinary property write after the call, while the acquisition awaits its guard.
  requestB.processInstanceId = "procA";
  try {
    await reachesWitnessAppend(gate, pending);
    const acquiredA = await acquireRuntimeLease(
      operationRequest(directoryA, clock, "procA", "ownerA", latchA),
    );
    assert.equal(acquiredA.disposition, "ACQUIRED");
    assert.ok(acquiredA.authority);
    const issued = acquiredA.authority;
    const issuedBytes = await snapshot(directoryA);
    const hooked = await onIssued(issued);
    if (order.heldCompletesFirst) {
      gate.release();
      await pending;
    }
    clock.set(HEARTBEAT_MS);
    const beat = await heartbeatRuntimeLease(tokenRequest(directoryA, issued, clock, latchA));
    assert.equal(beat.disposition, "HEARTBEAT_COMMITTED");
    assert.ok(beat.authority);
    gate.release();
    return { issued, issuedBytes, current: beat.authority, held: await pending, onIssued: hooked };
  } finally {
    gate.restore();
    await pending;
  }
}

function assertHeldAcquiredAsCalled(held: LeaseResult): asserts held is LeaseResult & {
  authority: LeaseAuthority;
} {
  // The held acquisition claimed, wrote and published procB, as called.
  assert.equal(held.disposition, "ACQUIRED");
  assertIdentity(held.authority, {
    scopeKey: SCOPE_KEY,
    ownerId: "ownerA",
    processInstanceId: "procB",
  });
  assert.equal(held.record?.processInstanceId, "procB");
}

type AcquireDrift = {
  name: string;
  drift(request: LeaseOperationRequest, otherDirectory: string): void;
};

const ACQUIRE_DRIFTS: AcquireDrift[] = [
  {
    name: "processInstanceId",
    drift: (request) => {
      request.processInstanceId = "procZ";
    },
  },
  {
    name: "ownerId",
    drift: (request) => {
      request.ownerId = "ownerZ";
    },
  },
  {
    name: "scopeKey",
    drift: (request) => {
      request.scopeKey = OTHER_SCOPE_KEY;
    },
  },
  {
    name: "directory",
    drift: (request, otherDirectory) => {
      request.directory = otherDirectory;
    },
  },
];

type AcquireKind = {
  name: string;
  // Prepares directory B and returns the clock to acquire it with.
  setup(directoryB: string): Promise<{ clock: SteppedClock; generation: string; useMs: bigint }>;
};

const ACQUIRE_KINDS: AcquireKind[] = [
  {
    name: "a first-generation initialization",
    setup: async () => ({ clock: steppedClock(T0_MS), generation: "1", useMs: USE_MS }),
  },
  {
    name: "a takeover of an expired lease",
    setup: async (directoryB) => {
      const clock = steppedClock(T0_MS);
      await acquire(directoryB, clock, "procS", "ownerS");
      clock.set(EXPIRED_MS);
      return { clock, generation: "2", useMs: EXPIRED_MS + 11_000n };
    },
  },
];

type TokenOperation = {
  name: string;
  run(request: LeaseTokenRequest): Promise<LeaseResult>;
  disposition: LeaseResult["disposition"];
  writes: boolean;
};

const TOKEN_OPERATIONS: TokenOperation[] = [
  {
    name: "heartbeat",
    run: heartbeatRuntimeLease,
    disposition: "HEARTBEAT_COMMITTED",
    writes: true,
  },
  { name: "release", run: releaseRuntimeLease, disposition: "RELEASED", writes: true },
  {
    name: "current-lease assertion",
    run: assertCurrentLease,
    disposition: "ACQUIRED",
    writes: false,
  },
];

type TokenDrift = {
  name: string;
  drift(request: LeaseTokenRequest, authority: LeaseAuthority, directory: string): void;
};

// Retargets a token request at another live lease after the call: by editing the token
// object the caller passed, or by replacing the request's token, with the directory too.
const RETARGETS: TokenDrift[] = [
  {
    name: "the passed token's fields and the directory are edited",
    drift: (request, authority, directory) => {
      Object.assign(request.authority, authority);
      request.directory = directory;
    },
  },
  {
    name: "the token and the directory are replaced",
    drift: (request, authority, directory) => {
      request.authority = { ...authority };
      request.directory = directory;
    },
  },
];

// Swaps a stale token for the current token of the same lease after the call.
const REFRESHES: TokenDrift[] = [
  {
    name: "the passed token's fields are edited",
    drift: (request, authority) => {
      Object.assign(request.authority, authority);
    },
  },
  {
    name: "the token is replaced",
    drift: (request, authority) => {
      request.authority = { ...authority };
    },
  },
];

describe("Gate 2 re-review RC8: a lease operation keeps the identity it was called with", {
  concurrency: 1,
}, () => {
  for (const order of ORDERS) {
    for (const latchCase of LATCH_CASES) {
      test(`RC8-01 an acquisition whose processInstanceId changes after the call cannot replace another instance's later commit; ${order.name}, ${latchCase} latch: no stale token sends`, async () => {
        await withRoot(async (root) => {
          const race = await newRace(root);
          const { clock, directoryA, directoryB, latchA, latchB } = race;
          const { issued, issuedBytes, held } = await runHeldAcquisition(
            race,
            order,
            async () => {},
          );

          // procA's pre-heartbeat token after an external rollback of its pair and witness.
          await restoreBytes(directoryA, issuedBytes);
          clock.set(USE_MS);
          const stale = await send(
            directoryA,
            issued,
            clock,
            latchCase === "original" ? latchA : new RuntimePersistenceLatch(),
          );
          assertNothingSent(stale);
          assert.ok(stale.result.reasonCodes.includes("LEASE_RECORD_DIVERGED"));

          assertHeldAcquiredAsCalled(held);
          assertSentOnce(await send(directoryB, held.authority, clock, latchB));
        });
      });
    }
  }

  for (const kind of ACQUIRE_KINDS) {
    for (const drift of ACQUIRE_DRIFTS) {
      test(`RC8-02 ${kind.name} keeps its call-time ${drift.name} when the request changes after the call`, async () => {
        await withRoot(async (root) => {
          const directoryA = await freshDirectory(root, "a");
          const directoryB = await freshDirectory(root, "b");
          const { clock, generation, useMs } = await kind.setup(directoryB);
          const latch = new RuntimePersistenceLatch();
          const request = operationRequest(directoryB, clock, "procB", "ownerB", latch);

          const pending = acquireRuntimeLease(request);
          drift.drift(request, directoryA);
          const acquired = await pending;

          assert.equal(acquired.disposition, "ACQUIRED");
          assertIdentity(acquired.authority, {
            scopeKey: SCOPE_KEY,
            ownerId: "ownerB",
            processInstanceId: "procB",
          });
          assert.equal(acquired.authority.generation, generation);
          assert.equal(acquired.record?.processInstanceId, "procB");
          assert.equal(latch.blocked, false);
          // Nothing was written outside the guarded call-time directory.
          assert.equal((await snapshot(directoryA)).size, 0);
          clock.set(useMs);
          assertSentOnce(await send(directoryB, acquired.authority, clock));
        });
      });
    }
  }

  for (const operation of TOKEN_OPERATIONS) {
    for (const drift of RETARGETS) {
      test(`RC8-03 a ${operation.name} stays on its call-time lease when ${drift.name} after the call`, async () => {
        await withRoot(async (root) => {
          const clock = steppedClock(T0_MS);
          const directoryA = await freshDirectory(root, "a");
          const directoryB = await freshDirectory(root, "b");
          const tokenA = await acquire(directoryA, clock, "procA", "ownerA");
          const tokenB = await acquire(directoryB, clock, "procB", "ownerB");
          const bytesA = await snapshot(directoryA);
          const bytesB = await snapshot(directoryB);
          clock.set(HEARTBEAT_MS);
          const latch = new RuntimePersistenceLatch();
          const request = tokenRequest(directoryB, { ...tokenB }, clock, latch);

          const pending = operation.run(request);
          drift.drift(request, tokenA, directoryA);
          const result = await pending;

          assert.equal(result.disposition, operation.disposition);
          assertIdentity(result.authority, {
            scopeKey: SCOPE_KEY,
            ownerId: "ownerB",
            processInstanceId: "procB",
          });
          assert.equal(latch.blocked, false);
          assert.deepEqual(await snapshot(directoryA), bytesA);
          assert.equal(!mapsEqual(await snapshot(directoryB), bytesB), operation.writes);
          // procA's lease was not touched, so its token still sends.
          clock.set(USE_MS);
          assertSentOnce(await send(directoryA, tokenA, clock));
        });
      });
    }
  }

  test("RC8-04 a failed heartbeat blocks the latch it was called with, not one swapped in after the call", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directory = await freshDirectory(root, "a");
      const issued = await acquire(directory, clock, "procA", "ownerA");
      clock.set(HEARTBEAT_MS);
      await heartbeat(directory, issued, clock);
      const original = new RuntimePersistenceLatch();
      const swapped = new RuntimePersistenceLatch();
      const request = tokenRequest(directory, issued, clock, original);

      // The pre-heartbeat token no longer matches the durable lease.
      const pending = heartbeatRuntimeLease(request);
      request.latch = swapped;
      const result = await pending;

      assert.notEqual(result.disposition, "HEARTBEAT_COMMITTED");
      assert.equal(result.authority, null);
      assert.equal(original.blocked, true);
      assert.equal(swapped.blocked, false);
    });
  });

  for (const drift of REFRESHES) {
    test(`RC8-05 a mutation called with a stale token is not sent when ${drift.name} after the call`, async () => {
      await withRoot(async (root) => {
        const clock = steppedClock(T0_MS);
        const directory = await freshDirectory(root, "a");
        const issued = await acquire(directory, clock, "procA", "ownerA");
        clock.set(HEARTBEAT_MS);
        const current = await heartbeat(directory, issued, clock);
        clock.set(USE_MS);
        let calls = 0;
        const request = {
          ...tokenRequest(directory, { ...issued }, clock),
          mutation: () => {
            calls += 1;
            return "sent";
          },
        };

        const pending = runLeaseFencedMutation(request);
        drift.drift(request, current, directory);
        const result = await pending;

        assertNothingSent({ result, calls });
        assert.ok(result.reasonCodes.includes("STALE_LEASE_TOKEN"));
      });
    });
  }

  test("RC8-06 a mutation called with a stale token in one directory is not sent through another lease named after the call", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directoryA = await freshDirectory(root, "a");
      const directoryB = await freshDirectory(root, "b");
      const tokenA = await acquire(directoryA, clock, "procA", "ownerA");
      const staleB = await acquire(directoryB, clock, "procB", "ownerB");
      clock.set(HEARTBEAT_MS);
      await heartbeat(directoryB, staleB, clock);
      clock.set(USE_MS);
      let calls = 0;
      const request = {
        ...tokenRequest(directoryB, { ...staleB }, clock),
        mutation: () => {
          calls += 1;
          return "sent";
        },
      };

      const pending = runLeaseFencedMutation(request);
      request.directory = directoryA;
      request.authority = { ...tokenA };
      const result = await pending;

      assertNothingSent({ result, calls });
      assertSentOnce(await send(directoryA, tokenA, clock));
    });
  });

  test("RC8-07 a sent mutation runs the callback it was called with, not one swapped in after the call", async () => {
    await withRoot(async (root) => {
      const clock = steppedClock(T0_MS);
      const directory = await freshDirectory(root, "a");
      const issued = await acquire(directory, clock, "procA", "ownerA");
      let original = 0;
      let swapped = 0;
      const request = {
        ...tokenRequest(directory, issued, clock),
        mutation: () => {
          original += 1;
          return "original";
        },
      };

      const pending = runLeaseFencedMutation(request);
      request.mutation = () => {
        swapped += 1;
        return "swapped";
      };
      const result = await pending;

      assert.equal(result.outcome, "SENT");
      assert.equal(result.value, "original");
      assert.equal(original, 1);
      assert.equal(swapped, 0);
    });
  });

  for (const order of ORDERS) {
    for (const latchCase of LATCH_CASES) {
      for (const token of ["first", "heartbeat"] as const) {
        const expectation =
          token === "first" ? "places nothing after a rollback" : "places once (control)";
        test(`RC8-08 Phase 3: a fence built from procA's ${token} token ${expectation}; ${order.name}, ${latchCase} latch`, async () => {
          await withRoot(async (root) => {
            const race = await newRace(root);
            const { clock, directoryA, latchA } = race;
            const harnessFor = (authority: LeaseAuthority) =>
              createHarness({
                fence: createLeaseMutationFence({
                  directory: directoryA,
                  scopeKey: SCOPE_KEY,
                  authority,
                  latch: latchCase === "original" ? latchA : new RuntimePersistenceLatch(),
                  clock,
                }),
              });
            // The first token's fence is built before procA heartbeats.
            const outcome = await runHeldAcquisition(race, order, harnessFor);
            clock.set(USE_MS);

            if (token === "first") {
              const h = outcome.onIssued;
              // procA's pre-heartbeat token after an external rollback of its pair and witness.
              await restoreBytes(directoryA, outcome.issuedBytes);
              await grant(h.coordinator);
              const submitted = await h.coordinator.submit(
                buildIntent({ leaseGeneration: outcome.issued.generation }),
              );
              assert.equal(submitted.record?.status, "NOT_SENT");
              assert.ok(submitted.reasonCodes.includes("FENCE_NOT_SENT"));
              assert.ok(submitted.reasonCodes.includes("MUTATION_NOT_SENT"));
              assert.equal(h.venue.calls.place, 0);
            } else {
              const h = await harnessFor(outcome.current);
              await grant(h.coordinator);
              const placed = await h.coordinator.submit(
                buildIntent({ leaseGeneration: outcome.current.generation }),
              );
              assert.equal(placed.record?.status, "LINKED");
              assert.equal(h.venue.calls.place, 1);
            }

            assertHeldAcquiredAsCalled(outcome.held);
          });
        });
      }
    }
  }
});

function mapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}
