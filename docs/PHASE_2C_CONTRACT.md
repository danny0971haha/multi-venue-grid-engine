# Phase 2C Implementation Contract — Runtime Lease and Fencing

**Status:** AUTHORIZED AFTER INDEPENDENT PHASE 2B PASS  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`  
**Accepted Phase 2B HEAD:** `41eb277a7d6dfe36dbb864bc8190d5a20663dc4a`  
**Accepted Phase 2B TREE:** `8163e36c676f8b1d5332cdbc713b0672ea4fe148`  
**Accepted Phase 2B CI:** `32708431819`  
**Parent contracts:** `AGENTS.md`, `docs/IMPLEMENTATION_CONTRACT.md`, `docs/PHASE_2A_CONTRACT.md`, `docs/PHASE_2B_CONTRACT.md`, `docs/RISK_PERSISTENCE_CONTRACT.md`, `docs/TEST_FAULT_MATRIX.md`, `docs/REVIEW_CHANGE_PROTOCOL.md`

This file binds the authorized Phase 2C prompt. It is a bounded elaboration of parent contracts. It does **not** weaken:

- exact-pair authority;
- backup-first ordering;
- persistence latch no-reset semantics;
- no automatic repair;
- no higher-generation auto-selection;
- `allowRiskIncrease=false`;
- live-mode prohibition.

Where this file is more specific, it adds fail-closed constraints. Where a parent rule is stricter, the parent rule wins.

## 1. Authorization

Implement **Phase 2C only**: durable runtime lease, exactly-one current runtime per scope, atomic host-local acquisition coordination, monotonic fencing generation, heartbeat, expiry, takeover, release, fresh lease assertion, mutation-adjacent fencing, a real child-process contention/crash matrix, and deterministic network-free evidence.

```text
PHASE_2A=PASS
PHASE_2B=PASS
ACCEPTED_PHASE_2B_HEAD=41eb277a7d6dfe36dbb864bc8190d5a20663dc4a
ACCEPTED_PHASE_2B_TREE=8163e36c676f8b1d5332cdbc713b0672ea4fe148
AUTHORIZED_CHECKPOINT=PHASE_2C_ONLY
PHASE_2C=REVIEW_CANDIDATE
PHASE_2C_SELF_DECLARED_PASS=NO
PHASE_2D_AUTHORIZED=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2F_AUTHORIZED=NO
GATE_2=NOT_REVIEWED
ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

The implementation agent must not declare `PHASE_2C=PASS` or `GATE_2=PASS`. The independent reviewer owns that decision.

Do not begin Phase 2D–2F.

## 2. Explicitly out of scope

Do **not** implement:

- risk calculations;
- `CONTINUE` / `REDUCE` / `HALT` gate;
- exposure / loss / drawdown / boundary guards;
- halt state machine;
- kill switch;
- halt acknowledgement;
- telemetry / manifest;
- execution coordinator;
- venue adapters;
- exchange authentication;
- network requests;
- live mode;
- auto repair;
- automatic newer-copy selection.

## 3. Persistence and risk authority

Every Phase 2C API returns:

```text
allowRiskIncrease=false
```

A committed lease is storage-and-fencing evidence only. It is not risk-increase authorization. Phase 2D risk gates do not exist yet.

Caller-supplied objects, including a previously returned `LeaseAuthority`, are never durable authority. The current exact pair on disk is the only lease authority.

The following are not sufficient to prove owner or generation:

- PID alone;
- hostname alone;
- heartbeat metadata alone;
- a caller-supplied generation alone.

## 4. Required modules

```text
src/persistence/lease-coordination.ts
src/persistence/runtime-lease.ts
```

Phase 2A and Phase 2B current-byte files remain frozen unless a change is unavoidable and evidence proves frozen canonical vectors and Phase 2B crash outcomes are unchanged:

```text
src/persistence/canonical-json.ts
src/persistence/durable-envelope.ts
src/persistence/exact-pair-inspection.ts
src/persistence/atomic-pair-store.ts
src/persistence/runtime-persistence-latch.ts
```

No new dependency is authorized. If a standard Node / OS primitive is insufficient, stop with `CONTRACT_CHANGE_REQUIRED` / `DEPENDENCY_APPROVAL_REQUIRED`.

Existing `setPersistenceFaultHookForTests` remains:

- default `null`;
- no env / CLI / runtime activation path;
- not installed by production startup;
- not triggerable by ordinary configuration.

## 5. Lease record

Project-owned payload stored as a Phase 2B exact pair.

```text
kind = runtime-lease
stateName = runtime-lease
schemaVersion = 1
```

`scopeKey` must be the exact-pair envelope scope and must match the experiment exact-pair scope string.

Required payload fields, and no others:

```ts
type RuntimeLeaseRecord = {
  schemaVersion: 1;
  scopeKey: string;
  ownerId: string;
  processInstanceId: string;
  generation: string;
  status: "ACTIVE" | "RELEASED";
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  updatedAt: string;
};
```

Rules:

- `generation` is a canonical positive decimal string matching `^[1-9][0-9]{0,38}$`.
- `generation` is never converted through JavaScript `number`.
- Takeover increments `generation` with the accepted Phase 2B `BigInt` decimal-string method.
- Heartbeat does not change `generation` or `acquiredAt`.
- `ownerId` and `processInstanceId` are non-empty and match `^[A-Za-z][A-Za-z0-9._:-]{0,63}$`.
- Invalid / missing / extra fields fail closed.
- Invalid / missing / non-canonical timestamps fail closed.

Envelope `storeGeneration` is the Phase 2B pair generation. It increments on every committed lease write. Fencing `generation` increments only on first acquire and on takeover, including acquire-after-release.

## 6. LeaseAuthority

Returned only after final exact-pair readback. It is a token for later comparison, not authority.

```ts
type LeaseAuthority = {
  scopeKey: string;
  ownerId: string;
  processInstanceId: string;
  generation: string;
  leaseEnvelopeSha256: string;
  leaseStoreGeneration: string;
  observedExpiresAt: string;
};
```

A loose `{ isOwner: true }` boolean is forbidden.

## 7. Coordination capability

Phase 2B exact-pair transition is not a multi-process mutex.

Phase 2C adds a host-local atomic coordination primitive that serializes:

- first initialization;
- acquire;
- heartbeat;
- takeover;
- release;
- mutation-adjacent assertion.

```text
COORDINATION_CAPABILITY=HOST_LOCAL_FILESYSTEM_ONLY
DISTRIBUTED_FENCING_PROVEN=NO
```

Primitive:

1. Atomic exclusive file create (`llock`) with `O_EXCL` in the lease directory.
2. The creator writes this process PID as a canonical decimal string and keeps the file handle until release. PID is a host-local liveness hint only. It is not lease authority and does not prove owner, generation, or fencing.
3. A waiter that observes `EEXIST` reads `llock`. An empty/in-progress file is treated as a live claim (wait). A well-formed PID uses `process.kill(pid, 0)`: `ESRCH` is stale, `EPERM` is live. Malformed nonempty bytes are uncertain.
4. Release closes the handle and unlinks `llock`. Unexpected sibling files are not deleted.

This implementation proves only a single-host local filesystem. It does not prove NFS, SMB, or multi-host coordination. It does not import `node:net` or any other Phase 0 forbidden network module.

If the caller requests any shared / multi-host / distributed coordination mode:

```text
DISTRIBUTED_FENCING_UNPROVEN
```

and the operation does not continue.

### 7.1 Contention

Two real child processes racing `mkdir` yield exactly one creator. The loser observes `EEXIST` and must not treat that as ownership.

A read-then-write boolean is forbidden. An in-memory mutex is forbidden as the only coordination mechanism.

### 7.2 Crash recovery

If the holder dies:

- the OS closes the socket listener;
- the lock directory and socket path may remain.

Recovery rules:

1. `EEXIST` + live or in-progress claim → wait and retry until deadline, then fail closed (`COORDINATION_LOCK_TIMEOUT`).
2. `EEXIST` + `ESRCH` / stale PID → exclusive-create `llock.recover`. Recheck liveness. If still stale, unlink only `llock` and `llock.recover`. Do not recursively delete. Retry acquire.
3. Missing lock file after `EEXIST` → another recoverer already removed it. Retry exclusive create. Do not treat this as ownership.
4. Malformed nonempty lock bytes → `COORDINATION_LOCK_UNCERTAIN`. Fail closed. Do not delete conflicting evidence.
5. Lock uncertainty never authorizes a lease write or mutation.

### 7.3 Critical section

The coordination guard is a short critical-section mutex, not a process-lifetime lock. It is released after each acquire / heartbeat / takeover / release / assertion. An expired lease can be taken over while the previous owner process is still alive.

## 8. Frozen clock and expiry rules

```text
LEASE_TTL_MS=30000
MAX_CLOCK_SKEW_MS=1000
MAX_FORWARD_JUMP_MS=86400000
```

Timestamps are canonical Unix-millisecond decimal strings matching `^(0|[1-9][0-9]{0,12})$`. They are compared as `BigInt`. They are never used as IEEE financial values, but they are still not converted through generation/`number` fencing arithmetic.

Time boundaries:

```text
expired              <=>  nowMs >= expiresAtMs
CLOCK_REGRESSION     <=>  heartbeatAtMs - nowMs > MAX_CLOCK_SKEW_MS
                         or acquiredAtMs - nowMs > MAX_CLOCK_SKEW_MS
FUTURE_TIMESTAMP     <=>  acquiredAtMs - nowMs > MAX_CLOCK_SKEW_MS
CLOCK_FORWARD_JUMP   <=>  nowMs - heartbeatAtMs > MAX_FORWARD_JUMP_MS
EXCESSIVE_TIMESTAMP  <=>  timestamp digits exceed 13 or value > 9999999999999
MALFORMED_TIMESTAMP  <=>  missing, non-string, non-canonical, or leading-zero (except "0")
```

Exact expiry boundary: `nowMs == expiresAtMs` is expired. Takeover is allowed only after the coordination guard is held and a durable generation increment commits. `nowMs == expiresAtMs - 1` is not expired. A second owner is blocked.

Record invariants on every accepted write:

```text
acquiredAt <= heartbeatAt
expiresAt  == heartbeatAt + LEASE_TTL_MS
updatedAt  >= heartbeatAt
```

Clock source:

- production default: system clock (`Date.now()` captured once per operation into `BigInt`);
- tests may inject a deterministic clock;
- one operation uses one captured `nowMs`.

Malformed timestamps fail closed. Clock regression beyond tolerance fails closed and leaves authority unproven. Process death does not bypass durable expiry or coordination rules.

## 9. Acquisition protocol

1. Reject distributed / shared-host coordination modes.
2. Require `RuntimePersistenceLatch` not blocked.
3. Obtain the host-local coordination guard.
4. Independently inspect the lease exact pair.
5. Clean `BOTH_ABSENT` with no sibling temp / historical evidence: Phase 2B `initializeExactPair` with `mode=NON_LIVE_BOOTSTRAP` and `allowLive=false`, fencing generation `"1"`.
6. Existing pair: require proven kind / scope / schema and a valid lease record.
7. `ACTIVE` and not expired: reject a second owner. Do not write.
8. `ACTIVE` and expired, or `RELEASED`: takeover with Phase 2B compare-and-commit. Fencing generation = previous + 1. New `ownerId` / `processInstanceId` / `acquiredAt`.
9. Persist through accepted backup-first transition.
10. Final exact-pair readback.
11. Confirm durable `ownerId`, `processInstanceId`, and `generation`.
12. Return `LeaseAuthority`.
13. `allowRiskIncrease=false`.

Unproven / missing-one-copy / corrupt / conflicting / ahead pairs block the latch and return authority unproven. They are never auto-repaired and never auto-selected by higher generation.

## 10. Heartbeat protocol

1. Reject distributed coordination modes.
2. Require latch not blocked.
3. Obtain the coordination guard.
4. Fresh-read the exact durable lease.
5. Require exact match of scope / ownerId / processInstanceId / fencing generation.
6. Require `ACTIVE` and not expired.
7. Require clock rules in Section 8.
8. Do not change fencing generation or `acquiredAt`.
9. `heartbeatAt` is monotonic non-decreasing (`max(previous, now)`).
10. `expiresAt = heartbeatAt + LEASE_TTL_MS`.
11. Phase 2B compare-and-commit.
12. Final exact-pair readback.
13. Failure or ambiguity permanently blocks this process latch.

Old owner, old generation, or forged token cannot heartbeat. A later successful heartbeat write cannot clear a previously blocked latch.

## 11. Takeover and fencing

Takeover is the acquire path used when the durable lease is `RELEASED` or `ACTIVE` and expired.

After a committed takeover:

- the old owner is permanently fenced in that process once it observes mismatch, expiry, or hash divergence;
- old-owner heartbeat fails and does not rewrite disk;
- old-owner release fails and does not rewrite disk;
- old-owner mutation returns `NOT_SENT` with callback count `0`;
- rewriting the previous lease bytes cannot restore the old token;
- the same `ownerId` with the previous `processInstanceId` cannot restore authority.

A stale process cannot regain authority by writing its old lease record. Official lease APIs never decrease fencing generation. Seeing a lower fencing generation than this process has already observed is unproven and blocks the latch.

## 12. Release protocol

Release does not delete lease files or history.

Only the exact current tuple may transition to `RELEASED`:

```text
scopeKey
ownerId
processInstanceId
generation
```

After release:

- the current token cannot mutate;
- the next acquire must commit a strictly higher fencing generation;
- a stale release cannot overwrite a newer owner;
- release persistence uncertainty blocks the latch.

Deleting lease files is not a legal release.

## 13. Mutation-adjacent fence

Production-shaped, network-free abstractions:

```text
assertCurrentLease(...)
runLeaseFencedMutation(...)
```

Phase 2C must not connect a venue transport.

`runLeaseFencedMutation`:

1. Obtain the coordination guard.
2. Fresh-inspect the exact durable lease.
3. Check the persistence latch.
4. Check scope, ownerId, processInstanceId, generation, `ACTIVE`, and unexpired.
5. Invoke the test-only pre-callback hook if one is installed (default `null`; no production activation).
6. Reconfirm on a final synchronous boundary (`readFileSync` of both pair files, parse, compare expected envelope hash / generation / owner / process instance, latch, clock).
7. Call the test / simulator callback at most once, and only if every check passed.
8. Failure before callback: `NOT_SENT`, callback count `0`.
9. Callback entered and threw: `UNKNOWN`, callback count `1`. Do not disguise `UNKNOWN` as `NOT_SENT`.
10. Callback returned: fencing outcome `SENT`, still `allowRiskIncrease=false`.

A successful assertion does not permanently authorize the process. Each mutation in a sequence rechecks.

## 14. Persistence latch composition

Phase 2B latch semantics are unchanged:

- once blocked, this process cannot reset the latch;
- a later successful exact-pair write cannot clear it;
- `allowRiskIncrease` remains `false`.

Lease operations that observe unproven storage, I/O failure, clock-rule failure, or persist ambiguity block the latch. A normal second-owner rejection does not.

## 15. Required tests

Implement parent `P2-L01` through `P2-L08` and:

```text
2C-L01 first owner acquires clean scope; generation "1"
2C-L02 two real child processes; exactly one ACQUIRED
2C-L03 32 real concurrent contenders; exactly one current owner
2C-L04 unexpired current lease blocks second owner
2C-L05 expiry minus 1ms blocked; exact expiry matches Section 8
2C-L06 expired takeover; generation strictly +1
2C-L07 generation above Number.MAX_SAFE_INTEGER increments exactly
2C-L08 old owner heartbeat after takeover rejected; old owner does not rewrite disk
2C-L09 old owner mutation after fencing: NOT_SENT, callback count 0
2C-L10 generation replaced between preflight and callback: callback count 0
2C-L11 lease lost mid-sequence: later mutations NOT_SENT
2C-L12 stale owner rewrite of old lease record cannot restore authority
2C-L13 forged ownerId / processInstanceId / generation rejected
2C-L14 missing / corrupt / conflicting / ahead pair: unproven, latch blocked
2C-L15 already-blocked latch: acquire / heartbeat / mutation fail
2C-L16 later successful exact-pair write cannot clear blocked latch
2C-L17 heartbeat keeps owner / generation / acquiredAt; updates only allowed fields
2C-L18 clock regression beyond tolerance fails closed
2C-L19 malformed / future / excessive timestamp fails closed
2C-L20 SIGKILL active owner: pre-expiry contender blocked; post-expiry generation +1
2C-L21 crash during initial acquisition: clean absent / exact lease / unproven; never two owners
2C-L22 crash during heartbeat: old exact / new exact / unproven
2C-L23 crash during takeover: old owner / new owner / unproven; never both authorized
2C-L24 release: old token cannot mutate; next acquire has higher generation
2C-L25 stale release cannot overwrite new owner
2C-L26 HOST_LOCAL_FILESYSTEM_ONLY cannot claim distributed proof
2C-L27 same-process repeated assertions are deterministic
2C-L28 all 219 prior tests remain present
2C-L29 all Phase 2B backup A..H / primary A..H SIGKILL cases remain present
2C-L30 dry-run remains liveExchangeWrites=false
```

Parent tests must spawn real child processes. Assertions use durable bytes and OS coordination state, not child in-memory state. Ubuntu CI must not skip these cases.

## 16. Reviewer decision

The implementation agent requests independent review of Phase 2C only. It must not self-declare `PHASE_2C=PASS` or `GATE_2=PASS`.
