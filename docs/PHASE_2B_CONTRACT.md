# Phase 2B Implementation Contract — Backup-First Atomic Persistence and Real Process-Crash Matrix

**Status:** AUTHORIZED AFTER INDEPENDENT PHASE 2A PASS  
**Date:** 2026-08-24  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`  
**Base branch / accepted Phase 2A HEAD:** `51400c0f5a43c96f691115383e565743f543c9ee`  
**Accepted Phase 2A TREE:** `fa5068d6e0de0281f52f64a8a5539f054b64961d`  
**Accepted Phase 2A CI:** `32703392519`  
**Parent contracts:** `AGENTS.md`, `docs/IMPLEMENTATION_CONTRACT.md`, `docs/PHASE_2A_CONTRACT.md`, `docs/RISK_PERSISTENCE_CONTRACT.md`, `docs/TEST_FAULT_MATRIX.md`, `docs/REVIEW_CHANGE_PROTOCOL.md`

This file binds the authorized Phase 2B prompt. It does **not** weaken any parent contract. Where this file is more specific, it adds fail-closed constraints. Where a parent rule is stricter, the parent rule wins.

## 1. Authorization

Implement **Phase 2B only**: backup-first atomic exact-pair persistence, explicit initial exact-pair creation, predecessor compare-and-commit, persistence dispositions, a process-lifetime `RuntimePersistenceLatch`, and a real child-process `SIGKILL` storage matrix with deterministic network-free evidence.

```text
PHASE_2A=PASS
ACCEPTED_PHASE_2A_HEAD=51400c0f5a43c96f691115383e565743f543c9ee
ACCEPTED_PHASE_2A_TREE=fa5068d6e0de0281f52f64a8a5539f054b64961d
PHASE_2B_AUTHORIZED=YES
AUTHORIZED_CHECKPOINT=PHASE_2B_ONLY
PHASE_2B=REVIEW_CANDIDATE
PHASE_2B_SELF_DECLARED_PASS=NO
PHASE_2C_AUTHORIZED=NO
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

The implementation agent must not declare `PHASE_2B=PASS` or `GATE_2=PASS`. The independent reviewer owns that decision.

If current `HEAD` / `TREE` is not the accepted Phase 2A baseline and the extra commits cannot be proven as this Phase 2B continuation, stop with `BLOCKED_CURRENT_BYTE_MISMATCH`. Do not reset, force-push, or overwrite newer commits.

## 2. Explicitly out of scope

Do **not** implement:

- runtime lease / fencing;
- risk calculations;
- `CONTINUE` / `REDUCE` / `HALT` gate;
- halt state machine;
- durable halt acknowledgement;
- telemetry / manifest;
- execution coordinator;
- venue adapter;
- network access;
- live mode;
- auto repair;
- automatic newer-copy selection;
- HALT-transition or ACK-transition crash matrices (those require Phase 2E state).

Do not begin Phase 2C–2F.

## 3. Persistence authority is not trading authority

Every Phase 2B API returns:

```text
allowRiskIncrease=false
```

A durable commit that yields `REQUESTED_STATE_COMMITTED` is storage evidence only. It is not risk-increase authorization. Lease, risk gate, and restart reconciliation do not exist yet.

The process-lifetime latch proves only that this process lost persistence authority. It is not a venue-mutation fence and must not be read as a trading authorization.

## 4. Required modules

Responsibilities stay separate:

```text
src/persistence/runtime-persistence-latch.ts
src/persistence/atomic-pair-store.ts
```

Phase 2A current-byte files remain frozen unless a change is unavoidable and evidence proves frozen canonical vectors and Phase 2A semantics are unchanged:

```text
src/persistence/canonical-json.ts
src/persistence/durable-envelope.ts
src/persistence/exact-pair-inspection.ts
```

No new dependency is authorized. If a standard Node API is insufficient, stop with `CONTRACT_CHANGE_REQUIRED`.

## 5. Required API

At least:

- `initializeExactPair(...)`
- `persistExactPairTransition(...)`
- `RuntimePersistenceLatch`
- `PersistResult` / `PersistDisposition`
- test-only fault-hook interface

```ts
type PersistDisposition =
  | "REQUESTED_STATE_COMMITTED"
  | "PREDECESSOR_UNPROVEN"
  | "PARTIAL_COMMIT"
  | "FINAL_PAIR_UNPROVEN"
  | "IO_FAILURE";

type PersistResult<T> = {
  disposition: PersistDisposition;
  state: T | null;
  allowRiskIncrease: false;
  reasonCodes: string[];
  committedEnvelopeSha256: string | null;
  committedGeneration: string | null;
  inspection: PairInspection;
  latchState: {
    blocked: boolean;
    reasonCodes: string[];
    blockedAt: string | null;
  };
};
```

`state` is the committed detached payload only when `REQUESTED_STATE_COMMITTED`. Otherwise it is `null`. This is stricter than inventing a committed state on failure.

## 6. Explicit initialization

Initialization must not be triggered by a general read or transition.

`initializeExactPair` is allowed only when all of the following are proven:

- primary does not exist;
- backup does not exist;
- there is no unresolved sibling temp / partial-state evidence for that `stateName`;
- expected `kind` is known;
- expected `scopeKey` is known;
- caller supplies explicit non-live/bootstrap authorization (`mode=NON_LIVE_BOOTSTRAP`, `allowLive=false`);
- generation is the canonical string `"1"`;
- `previousEnvelopeSha256 = null`;
- initial payload can be canonicalized;
- after create, primary and backup bytes are identical;
- final exact-pair inspection proves the new pair.

If only one copy exists, either copy is corrupt, copies conflict, or suspicious historical evidence exists:

```text
disposition=PREDECESSOR_UNPROVEN
allowRiskIncrease=false
latch blocked
```

That situation is never a clean initialization.

## 7. Transition precondition and compare-and-commit

Every transition must:

1. independently inspect primary and backup;
2. require an exact authoritative predecessor pair;
3. verify expected `kind`;
4. verify expected `scopeKey`;
5. verify caller-supplied expected generation;
6. verify caller-supplied expected predecessor envelope hash;
7. increment generation with a decimal-string / `BigInt`-safe method and never coerce through JavaScript `number`;
8. bind `previousEnvelopeSha256` to the predecessor envelope hash;
9. build immutable next bytes once with `buildDurableEnvelope`;
10. write those exact same next bytes to backup and primary.

Immediately before the first target write, re-inspect the pair (compare-and-commit). If the predecessor changed after the first inspection, fail closed. Do not write stale caller state.

Stale expected generation or stale predecessor hash must produce zero mutation.

## 8. Backup-first commit protocol

Normative order:

```text
inspect exact predecessor pair
-> compare-and-commit re-inspect
-> build immutable next bytes once
-> atomic commit BACKUP
-> reopen/read/validate BACKUP
-> require exact requested bytes
-> atomic commit PRIMARY
-> reopen/read/validate PRIMARY
-> final inspect PRIMARY + BACKUP
-> require exact next pair
```

Only a successful final exact-pair inspection may return `REQUESTED_STATE_COMMITTED`. `allowRiskIncrease` remains `false`.

If backup has been updated and primary has not:

```text
disposition=PARTIAL_COMMIT
latch blocked
```

Do not auto-complete primary. Do not retry until the copies happen to match. Do not delete or overwrite crash evidence.

## 9. Atomic single-target write

Each target write must:

1. validate `stateName` and reject `/`, `\`, `..`, absolute paths, empty names, and control characters;
2. place the temp file in the target directory;
3. use an unpredictable temp name and exclusive create (`wx` / `O_EXCL`);
4. use directory mode `0700`;
5. use temp/target file mode `0600`;
6. write with a complete write loop;
7. `fsync` the temp file;
8. close the temp file;
9. atomically rename temp → target;
10. `fsync` the parent directory on Linux / GitHub Actions (this implementation attempts directory `fsync` on every supported platform);
11. reopen the target;
12. read exact bytes;
13. require readback bytes to equal the requested bytes;
14. `parseAndValidateDurableEnvelope`;
15. verify kind, scope, generation, previous hash, payload hash, and envelope hash;
16. return an explicit result.

Rename success alone is not durable-commit proof.

If rename succeeds and later directory-`fsync` or readback is uncertain:

- disposition is not success;
- latch is blocked;
- disk evidence is preserved;
- a fresh process must re-inspect;
- the current process must not auto-repair.

## 10. Runtime persistence latch

Process-lifetime object:

```ts
type LatchState = {
  blocked: boolean;
  reasonCodes: string[];
  blockedAt: string | null;
};
```

The following permanently block this process:

- predecessor unproven;
- partial commit;
- I/O failure;
- target readback mismatch;
- final pair unproven;
- stale generation/hash;
- wrong kind/scope;
- ambiguous initialization;
- unsupported durability operation.

Once blocked:

- a later successful write must not clear the latch;
- `allowRiskIncrease` remains `false`;
- only a fresh process plus full durable inspection may create a new runtime context;
- there is no hidden reset / unblock method.

## 11. Test-only fault hooks

Stable hooks, independently for `BACKUP` and `PRIMARY`:

```text
A  BEFORE_TEMP_OPEN
B  AFTER_TEMP_OPEN
C  AFTER_TEMP_WRITE
D  AFTER_TEMP_FSYNC
E  AFTER_TEMP_CLOSE
F  AFTER_RENAME
G  AFTER_DIR_FSYNC
H  AFTER_TARGET_INSPECTION
```

Exception injection is not a substitute for the crash matrix.

## 12. Real process-crash matrix

Parent test must:

1. create a fresh temporary directory;
2. create an old exact pair;
3. have the child execute exactly one transition;
4. have the child notify the parent at the named hook;
5. have the parent send a real `SIGKILL`;
6. not reuse child runtime / module state;
7. reload disk from a fresh process / module;
8. assert only from persisted bytes.

Each fresh-reload outcome must be exactly one of:

```text
A. old exact pair proven
B. complete new exact pair proven
C. pair unproven, risk increase blocked
```

There is no fourth outcome.

Forbidden:

- selecting the higher generation and continuing;
- authorizing from a single valid copy;
- automatic post-crash repair;
- judging from child in-memory state;
- replacing `SIGKILL` with a thrown exception.

Required coverage:

```text
backup:A..H
primary:A..H
```

GitHub Actions Ubuntu must not skip these cases.

## 13. Required tests

```text
2B-P01 normal exact-pair transition success
2B-P02 next generation and previous hash exact
2B-P03 identical immutable bytes written to backup/primary
2B-P04 stale expected generation -> zero mutation
2B-P05 stale predecessor hash -> zero mutation
2B-P06 primary missing -> predecessor unproven
2B-P07 backup missing -> predecessor unproven
2B-P08 corrupt copy -> predecessor unproven
2B-P09 valid but different pair -> predecessor unproven
2B-P10 wrong kind/scope -> zero mutation
2B-P11 explicit clean initialization success
2B-P12 one-copy initialization attempt blocked
2B-P13 temp/historical evidence blocks initialization
2B-P14 backup commit success + primary failure -> partial commit
2B-P15 readback mismatch -> blocked
2B-P16 directory fsync failure -> blocked
2B-P17 later successful write cannot clear latch
2B-P18 unsafe stateName/path traversal rejected
2B-P19 caller payload/fields not mutated
2B-P20 deterministic reason-code ordering
2B-P21 diagnostics do not leak secret-like fixture values
2B-P22 all backup A..H real SIGKILL cases
2B-P23 all primary A..H real SIGKILL cases
2B-P24 no crash outcome authorizes risk increase
2B-P25 all existing Phase 2A vectors remain byte-identical
2B-P26 all existing 193 tests remain present and green
```

Do not weaken, delete, or rewrite existing Phase 0, Phase 1, or Phase 2A assertions.

## 14. Verification

Record command and exit code for:

```text
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run test:phase2a
npm run test:phase2b
npm test
npm run build
npm run scan:secrets
npm run dry-run
npm audit
git diff --check
git status --short
```

Pinned toolchain remains Node `22.23.2` and npm `10.9.8`. Existing 193 tests must remain present and green. New Phase 2B tests must pass. `npm audit` must not worsen. Dry-run must show `liveExchangeWrites=false`. Zero network access, zero production credentials, zero live exchange mutation.

## 15. Reviewer decision

The implementation agent requests independent review of Phase 2B only. It must not self-declare `PHASE_2B=PASS` or `GATE_2=PASS`.
