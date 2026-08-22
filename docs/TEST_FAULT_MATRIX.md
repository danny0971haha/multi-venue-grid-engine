# Test and Fault-Injection Matrix

Version: `0.1.0`

This matrix is binding for implementation/review. It defines the minimum evidence needed to claim that a phase is safe enough to move to the next phase.

Passing unit tests is necessary but not sufficient. Durability claims that depend on process death must use real child-process termination and fresh-process reload.

## 1. General test rules

Every test must be:

- deterministic;
- network-free unless it is explicitly a read-only venue integration test;
- independent of production credentials;
- explicit about final durable/runtime state;
- explicit about whether risk increase is allowed;
- unable to pass merely because an exception was swallowed.

Use fresh temporary directories for durable-state tests.

Where process crash is tested:

1. parent process prepares exact initial state;
2. child process performs exactly one declared operation;
3. child is terminated with real process death (`SIGKILL` on supported Unix platforms or an equivalent non-clean termination on Windows);
4. parent does **not** reuse the child module/runtime state;
5. a fresh process/module reload inspects disk bytes;
6. assertions are made from persisted state only.

Exception-only hooks do not prove crash durability.

## 2. Phase 0 — bootstrap matrix

| ID | Scenario | Required result |
|---|---|---|
| P0-01 | no runtime-mode config | resolves `DRY_RUN` |
| P0-02 | explicit `DRY_RUN` | starts successfully without network |
| P0-03 | invalid mode | fails closed/non-zero |
| P0-04 | `LIVE` requested | fails with `LIVE_MODE_NOT_IMPLEMENTED` |
| P0-05 | clean install | `npm ci` from committed lock succeeds |
| P0-06 | typecheck | strict typecheck exit 0 |
| P0-07 | lint/format | checks exit 0 |
| P0-08 | secret scan | no tracked secret material |
| P0-09 | CI | branch + PR workflow executes same checks |
| P0-10 | dry-run side effects | zero venue/network mutation calls |

## 3. Phase 1 — domain/grid/simulator matrix

### 3.1 Geometry

| ID | Scenario | Required result |
|---|---|---|
| P1-G01 | anchor 100, ±3%, 10 levels | theoretical levels exactly 99.4, 98.8, 98.2, 97.6, 97.0 and 100.6, 101.2, 101.8, 102.4, 103.0 before venue rounding |
| P1-G02 | arbitrary decimal anchor | deterministic decimal-string output; no IEEE drift |
| P1-G03 | tick rounding | explicit venue-rule rounding; no invalid tick |
| P1-G04 | quantity step | explicit quantity normalization |
| P1-G05 | min notional infeasible | reports unsupported/infeasible; does not increase budget/leverage |

### 3.2 Level state machine

| ID | Scenario | Required result |
|---|---|---|
| P1-S01 | seed entry -> ACK | `ENTRY_WORKING` only after ACK/observation |
| P1-S02 | seed entry -> REJECTED | no working order locally |
| P1-S03 | seed entry -> UNKNOWN | `RECONCILING`; possible exposure reserved |
| P1-S04 | partial fill execution | executed and remaining quantities both preserved |
| P1-S05 | multiple partial executions | execution IDs deduplicated; cumulative qty exact |
| P1-S06 | full entry fill | `POSITION_OPEN` and adjacent exit intent generated |
| P1-S07 | exit partial/full | state moves only from execution evidence |
| P1-S08 | cancel ACK | cancellation requested/accepted; not a fill |
| P1-S09 | order disappears | `RECONCILING`, not `FILL` |
| P1-S10 | position delta without execution | no invented fill/execution ID |

### 3.3 Identity/ownership

| ID | Scenario | Required result |
|---|---|---|
| P1-I01 | deterministic intent generation | same durable inputs -> same intended identity where required |
| P1-I02 | different logical levels | no client-ID collision |
| P1-I03 | new anchor epoch | old order does not silently become current owned level |
| P1-I04 | clearly foreign order | classified `UNOWNED` |
| P1-I05 | incomplete identity | classified `AMBIGUOUS` |
| P1-I06 | duplicate owned logical orders | deterministic winner/cleanup plan |
| P1-I07 | duplicate cleanup + unowned order | unowned order is never selected for cancel |

### 3.4 Simulator restart

| ID | Scenario | Required result |
|---|---|---|
| P1-R01 | restart with working entries | no blind reseed/duplicate intent |
| P1-R02 | restart with partial fill | partial quantity survives/reconciles |
| P1-R03 | restart with unknown write | risk increase blocked until resolved |
| P1-R04 | execution history overlap | same execution not double-counted |
| P1-R05 | execution history gap | reconciliation required; no silent continuation |

## 4. Phase 2 — risk matrix

| ID | Scenario | Required result |
|---|---|---|
| P2-R01 | planned worst-case = 149.99U | may continue if every other gate passes |
| P2-R02 | planned worst-case = 150U | boundary accepted exactly if no rounding pushes above |
| P2-R03 | planned worst-case >150U | `allowRiskIncrease=false` |
| P2-R04 | unknown placement could push >150U | unknown is reserved; new risk blocked |
| P2-R05 | actual notional >150U | active reduction path selected, not cancel-only |
| P2-R06 | reduction ACK but no fresh snapshot | reduction not yet proven |
| P2-R07 | reduction UNKNOWN | HALT/reconciliation; no new risk |
| P2-R08 | daily net PnL = -5U | hard halt |
| P2-R09 | daily net PnL below -5U | hard halt |
| P2-R10 | fee/funding component missing live | no substitution with zero; fail closed |
| P2-R11 | equity = starting -10U | hard halt |
| P2-R12 | equity below threshold | hard halt |
| P2-R13 | adverse long below lower*0.99 | hard halt |
| P2-R14 | adverse short above upper*1.01 | hard halt |
| P2-R15 | boundary crossed, no inventory | no automatic hard halt solely from boundary; strategy may block seeding |
| P2-R16 | stale position | no risk increase |
| P2-R17 | stale equity/PnL | no risk increase |
| P2-R18 | lease lost immediately before place | `NOT_SENT`; no mutation call |

## 5. Phase 2 — halt/ACK matrix

| ID | Scenario | Required result |
|---|---|---|
| P2-H01 | hard breach | unique halt ID persisted before/with remediation intent where storage remains provable |
| P2-H02 | cancel fails | halt remains non-running |
| P2-H03 | cancel UNKNOWN | halt remains non-running/reconciliation required |
| P2-H04 | flatten fails | `HALTED_UNFLAT` or `HALT_FAILED` |
| P2-H05 | flatten ACK + stale snapshot | not `HALTED_FLAT` |
| P2-H06 | fresh snapshot proves flat | may persist `HALTED_FLAT`, still not auto-running |
| P2-H07 | no ACK supplied on restart | remains halted |
| P2-H08 | stale previous halt ID supplied | rejected; remains halted |
| P2-H09 | random/mismatched halt ID | rejected; remains halted |
| P2-H10 | caller passes forged in-memory state + valid-looking ID | durable current exact pair wins; caller cannot authorize |
| P2-H11 | correct current ID but fresh venue state unsafe | ACK does not authorize RUNNING |
| P2-H12 | correct ID + all safe resume gates | RUNNING only after exact durable transition commits |
| P2-H13 | crash during ACK persistence | restart must never infer that halt was cleared from caller memory |

## 6. Phase 2 — durable exact-pair matrix

For each state fixture, inspect primary and backup independently.

| ID | Disk state | Required result |
|---|---|---|
| P2-D01 | valid identical pair | authority proven |
| P2-D02 | primary missing / backup valid | risk increase blocked |
| P2-D03 | backup missing / primary valid | risk increase blocked |
| P2-D04 | primary corrupt / backup valid | risk increase blocked |
| P2-D05 | backup corrupt / primary valid | risk increase blocked |
| P2-D06 | both corrupt | risk increase blocked |
| P2-D07 | both valid but bytes/generation differ | risk increase blocked |
| P2-D08 | backup one generation ahead | risk increase blocked; no auto-select-newer |
| P2-D09 | primary one generation ahead | risk increase blocked |
| P2-D10 | generation jumps unexpectedly | risk increase blocked |
| P2-D11 | previous-hash chain broken | risk increase blocked |
| P2-D12 | wrong scope/kind | risk increase blocked |
| P2-D13 | legacy/unknown schema | migration/review path; never silently treated current |
| P2-D14 | temp file remains beside old exact pair | temp is non-authoritative; old exact pair can be evaluated normally after fresh restart gate |

## 7. Required real process-crash storage matrix

The atomic-write implementation must expose test-only child-process fault hooks at stable step boundaries. At minimum use these conceptual windows for **both backup and primary targets**:

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

If the implementation groups steps differently, the reviewer must be able to map every meaningful durability boundary to an equivalent kill window.

### 7.1 Normal running-state transition

Run child-process `SIGKILL`/hard termination at every available window:

```text
backup:A..H
primary:A..H
```

Required post-crash invariant:

```text
fresh reload either proves the old exact pair,
OR proves the complete new exact pair,
OR blocks risk increase.
```

There is no allowed fourth outcome.

Expected broad classification:

- crash before backup rename normally leaves old exact pair authoritative;
- crash after backup becomes new while primary is old creates an unproven pair -> block;
- crash before primary rename after backup commit remains unproven -> block;
- crash after both target bytes are durably visible may yield new exact pair; it must still be independently validated.

Do not hard-code test expectations solely from hook names; assert actual bytes observed after fresh reload.

### 7.2 HALT persistence transition

Repeat every crash window while transitioning from `RUNNING` to a halted state.

Safety invariant:

- no restart may return risk-increase authority unless a complete exact predecessor/new pair proves a valid state;
- an ambiguous halt persistence must process-latch/block risk increase;
- remediation may continue only through explicit risk-reducing paths.

### 7.3 ACK / halt-clear transition

Repeat every crash window while acknowledging the current halt.

Safety invariant:

```text
old exact pair -> remains halted
partial/conflicting pair -> blocked/halted
new exact pair -> acknowledgement must match the durable current halt lineage; normal restart reconciliation still required
```

A crash must never cause `RUNNING` merely because the operator supplied the correct ID before the process died.

## 8. Runtime lease matrix

| ID | Scenario | Required result |
|---|---|---|
| P2-L01 | first owner acquires scope | generation assigned atomically |
| P2-L02 | second owner attempts while first current | blocked |
| P2-L03 | lease expires, new owner acquires | generation strictly increases |
| P2-L04 | old owner attempts write after fencing | write rejected before transport |
| P2-L05 | lease storage ambiguous | risk increase blocked |
| P2-L06 | lease lost during kill switch | no new risk; risk-reducing continuation only if safely authorized and generation is current |
| P2-L07 | stale owner rewrites old lease record | cannot regain authority |
| P2-L08 | restart | new process proves/acquires current generation before venue mutation |

## 9. Telemetry/manifest failure matrix

| ID | Scenario | Required result |
|---|---|---|
| P2-T01 | manifest directory unwritable before run | no risk-increasing run starts |
| P2-T02 | required manifest write fails | fail closed |
| P2-T03 | telemetry append fails during normal operation | risk increase blocked if evidence contract requires the event before/with transition |
| P2-T04 | telemetry failure during halt | halt/remediation authority is not cleared |
| P2-T05 | secret-like field offered to telemetry | redacted/rejected; test proves no raw secret bytes written |
| P2-T06 | process restart | event file remains append-only; prior lines unchanged |

## 10. Phase 3 — execution/reconciliation matrix

| ID | Scenario | Required result |
|---|---|---|
| P3-E01 | place ACK | stable mapping intent -> exchange order |
| P3-E02 | place REJECTED | no local working order |
| P3-E03 | place UNKNOWN, order later found by client ID | adopt proven owned order; no duplicate place |
| P3-E04 | place UNKNOWN, execution found | execution reconciled authoritatively |
| P3-E05 | place UNKNOWN, nothing found but evidence not definitive | remain blocked; no blind new ID |
| P3-E06 | cancel UNKNOWN | query/reconcile; do not assume cancelled |
| P3-E07 | cancel confirmed + no fill | closed/cancelled, not fill |
| P3-E08 | cancel races with fill | execution evidence wins; quantities reconcile |
| P3-E09 | two owned duplicate orders | deterministic cleanup; exposure reservation includes both until confirmed cancelled |
| P3-E10 | owned + unowned same price | never cancel unowned |
| P3-E11 | batch planning | cap checked against entire batch before first risk-increasing send |
| P3-E12 | lease lost mid-batch | remaining mutations `NOT_SENT` |
| P3-E13 | execution replay overlap | idempotent by execution ID |
| P3-E14 | out-of-order WebSocket execution | normalized/deduplicated; no negative remaining qty |
| P3-E15 | reconnect gap | REST/read reconciliation before new risk |

## 11. Fatal-runtime matrix

Use child processes where practical.

| ID | Scenario | Required result |
|---|---|---|
| F-01 | uncaught exception in strategy loop | process stops/fences; no subsequent place call |
| F-02 | unhandled rejection | process stops/fences; no subsequent place call |
| F-03 | fatal error after intent persisted but before transport | restart sees unresolved intent/NOT_SENT evidence and reconciles safely |
| F-04 | fatal error after transport before response | unresolved outcome is `UNKNOWN`; exposure reserved |
| F-05 | supervisor restart after fatal | full restart gate executes before risk increase |

## 12. Phase 4 — real venue read-only audit matrix

No live mutation is required.

At minimum prove using official docs and read-only/test fixtures:

| ID | Capability | Required evidence |
|---|---|---|
| V-01 | market rules | tick/step/min-size mapping |
| V-02 | account snapshot | provenance + timestamps |
| V-03 | position | signed normalized quantity/notional semantics |
| V-04 | open orders | stable IDs/status semantics |
| V-05 | order lookup | order/client-ID query behavior |
| V-06 | executions | authoritative fill endpoint/stream + stable ID |
| V-07 | partial fills | executed/remaining semantics |
| V-08 | leverage | set/readback docs or blocker |
| V-09 | reduce-only | official semantics |
| V-10 | reduction | partial/full close semantics |
| V-11 | cancellation | accepted versus confirmed semantics |
| V-12 | freshness | server timestamps / WebSocket sequencing |
| V-13 | rate limits | official current limits |
| V-14 | sandbox/testnet | availability and behavioral differences |

Missing authoritative fill path => `BLOCKED` for canary eligibility.

## 13. Integrated dry-run / fault gate

Before any future live-canary review, run an integrated simulator campaign that includes at least:

1. normal grid seed/fill/exit cycles;
2. partial fills;
3. place timeout/UNKNOWN;
4. cancel/fill race;
5. orphan and duplicate orders;
6. WebSocket gap/reconnect;
7. stale account/position snapshot;
8. actual notional breach and active reduction;
9. daily-loss halt;
10. drawdown halt;
11. boundary halt long and short;
12. kill-switch cancellation failure;
13. kill-switch reduction ambiguity;
14. process crash during durable risk write;
15. process crash during halt ACK;
16. runtime lease theft/loss;
17. telemetry failure;
18. fatal runtime error and supervisor-style restart.

The run must produce a manifest and append-only events sufficient to reconstruct every state transition.

## 14. Evidence requirements

For each matrix group implemented in a phase, the evidence packet must report:

```text
TEST_ID
TEST_FILE
TEST_NAME
PROCESS_ISOLATION=YES|NO
FAULT_INJECTION_METHOD
EXPECTED_FINAL_STATE
OBSERVED_FINAL_STATE
EXIT_CODE
```

Large matrices may be attached as machine-readable JSON/CSV artifacts, but the summary must state total/pass/fail/skip counts. Skipped mandatory tests are not a PASS.

## 15. Acceptance invariant

A fault test is failed if any path can:

- silently create unbounded exposure;
- authorize new risk from unproven durable state;
- convert order disappearance into an invented fill;
- clear a hard halt without current durable halt acknowledgement;
- allow a fenced/stale runtime to write;
- retry an ambiguous write with a conflicting identity;
- cancel an unowned order during reconciliation;
- claim a successful reduction without fresh position verification;
- continue normal trading after a fatal uncaught runtime error.
