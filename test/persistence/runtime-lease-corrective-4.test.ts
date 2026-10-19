import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

import type { LeaseWitnessLine } from "../../src/persistence/lease-witness.js";
import {
  appendLeaseWitnessLine,
  leaseWitnessPath,
  loadLeaseWitnessLog,
} from "../../src/persistence/lease-witness.js";
import {
  acquireRuntimeLease,
  fixedLeaseClock,
  resetLeaseProcessStateForTests,
} from "../../src/persistence/runtime-lease.js";
import { RuntimePersistenceLatch } from "../../src/persistence/runtime-persistence-latch.js";

const SCOPE_KEY = "canary-01/sim/BTC_USDC_PERP/grid-v0.1";
const NOW_MS = 1_000_000n;

type WitnessRequest = Parameters<typeof appendLeaseWitnessLine>[0];

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  resetLeaseProcessStateForTests();
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase2c-corr4-"));
  try {
    await run(directory);
  } finally {
    resetLeaseProcessStateForTests();
    await rm(directory, { recursive: true, force: true });
  }
}

function request(
  directory: string,
  overrides: Partial<Omit<WitnessRequest, "directory">> = {},
): WitnessRequest {
  return {
    directory,
    scopeKey: SCOPE_KEY,
    operation: "INITIALIZE",
    fencingGeneration: "1",
    leaseStoreGeneration: "1",
    targetEnvelopeSha256: "a".repeat(64),
    ownerId: "ownerA",
    processInstanceId: "procA",
    status: "PREPARE",
    createdAt: NOW_MS.toString(10),
    ...overrides,
  };
}

// The public request fields of a durable line, i.e. exactly what its writer passed in.
function retryOf(directory: string, line: LeaseWitnessLine): WitnessRequest {
  return {
    directory,
    scopeKey: line.scopeKey,
    operation: line.operation,
    fencingGeneration: line.fencingGeneration,
    leaseStoreGeneration: line.leaseStoreGeneration,
    targetEnvelopeSha256: line.targetEnvelopeSha256,
    ownerId: line.ownerId,
    processInstanceId: line.processInstanceId,
    status: line.status,
    createdAt: line.createdAt,
  };
}

async function appendOk(witness: WitnessRequest): Promise<LeaseWitnessLine> {
  const appended = await appendLeaseWitnessLine(witness);
  assert.ok(appended.ok, appended.ok ? "" : appended.reasonCodes.join(","));
  assert.equal(appended.idempotent, false);
  return appended.line;
}

async function durableLines(directory: string): Promise<LeaseWitnessLine[]> {
  const loaded = await loadLeaseWitnessLog(directory);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.reasonCodes.join(","));
  return loaded.lines;
}

async function assertIdempotentRetry(directory: string, label: string): Promise<void> {
  const before = await readFile(leaseWitnessPath(directory));
  const lines = await durableLines(directory);
  const last = lines[lines.length - 1];
  assert.ok(last !== undefined, label);

  const retried = await appendLeaseWitnessLine(retryOf(directory, last));
  assert.ok(retried.ok, `${label}: ${retried.ok ? "" : retried.reasonCodes.join(",")}`);
  assert.equal(retried.idempotent, true, label);
  assert.deepEqual(retried.line, last, label);
  assert.ok((await readFile(leaseWitnessPath(directory))).equals(before), label);
  assert.deepEqual(await durableLines(directory), lines, label);
}

async function assertConflict(witness: WitnessRequest, label: string): Promise<void> {
  const before = await readFile(leaseWitnessPath(witness.directory));
  const appended = await appendLeaseWitnessLine(witness);
  assert.equal(appended.ok, false, label);
  assert.deepEqual(
    appended.ok ? [] : appended.reasonCodes,
    ["WITNESS_DUPLICATE_CONFLICT", "LEASE_AUTHORITY_UNPROVEN"],
    label,
  );
  assert.ok((await readFile(leaseWitnessPath(witness.directory))).equals(before), label);
}

describe("Gate 2 corrective C7: exact retry of the last witness line", { concurrency: 1 }, () => {
  test("C7-1 an exact retry of the last line is idempotent and leaves the bytes unchanged", async () => {
    await withTempDir(async (directory) => {
      await appendOk(request(directory));
      await assertIdempotentRetry(directory, "first line PREPARE");

      await appendOk(request(directory, { status: "COMMIT" }));
      await assertIdempotentRetry(directory, "final COMMIT");
      await assertIdempotentRetry(directory, "second retry of final COMMIT");
    });
  });

  test("C7-2 an exact retry of the COMMIT written by a real acquisition is idempotent", async () => {
    await withTempDir(async (directory) => {
      const acquired = await acquireRuntimeLease({
        directory,
        scopeKey: SCOPE_KEY,
        ownerId: "ownerA",
        processInstanceId: "procA",
        latch: new RuntimePersistenceLatch(),
        clock: fixedLeaseClock(NOW_MS),
      });
      assert.equal(acquired.disposition, "ACQUIRED");
      const lines = await durableLines(directory);
      assert.deepEqual(
        lines.map((line) => line.status),
        ["PREPARE", "COMMIT"],
      );
      await assertIdempotentRetry(directory, "acquisition COMMIT");
    });
  });

  test("C7-3 a conflicting duplicate of the last line is still rejected and writes nothing", async () => {
    await withTempDir(async (directory) => {
      await appendOk(request(directory));
      await appendOk(request(directory, { status: "COMMIT" }));

      const changed: Array<[string, Partial<Omit<WitnessRequest, "directory">>]> = [
        ["createdAt", { createdAt: (NOW_MS + 1n).toString(10) }],
        ["targetEnvelopeSha256", { targetEnvelopeSha256: "b".repeat(64) }],
        ["ownerId", { ownerId: "ownerB" }],
        ["processInstanceId", { processInstanceId: "procB" }],
      ];
      for (const [label, overrides] of changed) {
        await assertConflict(request(directory, { status: "COMMIT", ...overrides }), label);
      }
      await assertIdempotentRetry(directory, "final COMMIT after rejected conflicts");
    });
  });

  test("C7-4 an exact retry of an earlier line is a conflicting duplicate, not a retry", async () => {
    await withTempDir(async (directory) => {
      await appendOk(request(directory));
      await appendOk(request(directory, { status: "COMMIT" }));
      await assertConflict(request(directory), "earlier PREPARE");
    });
  });
});
