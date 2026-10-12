# Phase 2D Corrective 2 Evidence Packet

Version: `0.1.0`  
Checkpoint: runtime input fail-closed boundary for `evaluateRisk`  
Requested reviewer decision: independent review of Phase 2D Corrective 2 only  
The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_2=PASS`, `PHASE_2C=PASS`, or `GATE_2=PASS`.

```text
CUMULATIVE_PHASE_2_BASELINE=PASS
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2D_CORRECTIVE_2=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
AUTHORITATIVE_START_HEAD=17411ea06802a19473842316a83906e7a5de06e5
AUTHORITATIVE_START_TREE=37047f48c1e02fdc8c474ebeb137444dcc02fbf3
WORKTREE_CLEAN_BEFORE=YES
LOCAL_EQUALS_REMOTE_BEFORE=YES
NODE_VERSION=v22.23.2
NPM_VERSION=10.9.8
TEST_TOTAL=378
TEST_PASS=378
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
TEST_CANCELLED=0
AUDIT_VULNERABILITIES=0
LIVE_EXCHANGE_WRITES=false
```

Exact result HEAD/TREE and GitHub Actions run IDs for that HEAD are recorded on Draft PR #3 after push.

## 1. Identity

```text
PHASE=2D_CORRECTIVE_2
REQUESTED_GATE=PHASE_2D_CORRECTIVE_2_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_2
CHECKPOINT=RUNTIME_INPUT_FAIL_CLOSED_BOUNDARY
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
AUTHORITATIVE_START_HEAD=17411ea06802a19473842316a83906e7a5de06e5
AUTHORITATIVE_START_TREE=37047f48c1e02fdc8c474ebeb137444dcc02fbf3
WORKTREE_CLEAN_BEFORE=YES
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2D_CORRECTIVE_1=REJECT
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
CUMULATIVE_PHASE_2_BASELINE=PASS
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
```

## 2. Toolchain

```text
OS=Darwin
ARCH=arm64
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
```

Local default `node` was v26.5.0. Validation used the official `node-v22.23.2-darwin-arm64` binary so the recorded toolchain matches the pin.

## 3. Defect reproduction matrix

Before this corrective, `evaluateRisk()` always called `validateRiskInput(input)` then `cloneInput(input)`. `cloneInput` dereferenced `input.ownedActiveOrders.map`, `input.unknownReservations.map`, and `input.proposedBatch.map` even when validation had already failed.

| ID | Input | Pre-fix behavior | Post-fix |
| --- | --- | --- | --- |
| P2D-C2-01 | `null` | throw | HALT, no throw |
| P2D-C2-02 | `undefined` | throw | HALT, no throw |
| P2D-C2-03 | string/number/boolean | throw or unsafe | HALT |
| P2D-C2-04 | missing `ownedActiveOrders` | throw on `.map` | HALT |
| P2D-C2-05 | `ownedActiveOrders` null/object/string | throw or string `.map` | HALT |
| P2D-C2-06 | `unknownReservations` non-array | throw | HALT |
| P2D-C2-07 | `proposedBatch` non-array | throw | HALT |
| P2D-C2-08 | malformed nested objects / class instance | throw or unsafe | HALT |
| P2D-C2-09 | array element null/primitive/malformed | unsafe spread | HALT |
| P2D-C2-10 | top-level throwing getter | exception escape | HALT, getter not invoked |
| P2D-C2-11 | nested throwing getter | exception escape | HALT, getter not invoked |
| P2D-C2-12 | stateful getter valid then malformed | TOCTOU | reject without second observation |
| P2D-C2-13 | Proxy `ownKeys` throws | exception escape | HALT |
| P2D-C2-14 | Proxy `getOwnPropertyDescriptor` throws | exception escape | HALT |
| P2D-C2-15 | sparse array / accessor index | throw or getter invoke | HALT, getter not invoked |

## 4. Parser / snapshot architecture

Public boundary: `evaluateRisk(input: unknown): RiskDecision`.

1. `parseAndSnapshotRiskInput` wraps the entire untrusted observation in `try/catch`.
2. The only observation of caller-owned data is `canonicalSerializeToUtf8(input)`, which reads own-property descriptors and rejects accessors without invoking getters.
3. `JSON.parse` materializes a detached plain snapshot. The caller object is not read again.
4. Structural completeness (exact keys, arrays of plain objects, nested object shapes, JSON types) is checked on the snapshot only.
5. Trusted evaluation (`validateRiskInput` + financial math) runs only on that snapshot.
6. Any throw or structural failure returns the deterministic invalid decision.

## 5. Property-observation policy

- Accessors are rejected by canonical serialization without getter invocation.
- Extra symbol keys, non-enumerable extras, class instances, sparse arrays, and extra array properties fail closed.
- Throwing `ownKeys` / `getOwnPropertyDescriptor` / `getPrototypeOf` traps are caught at the parse boundary.
- Stateful getters cannot TOCTOU because they are never invoked; the snapshot is a JSON clone.
- `evaluatedAt="0"` (`UNAUTHORIZED_EVALUATED_AT`) is a diagnostic sentinel only. It is not market time.

Invalid decision:

```text
action=HALT
reasonCodes include DURABLE_HALT_OR_ACK_UNAVAILABLE, INVALID_RISK_INPUT, STALE_OR_MISSING_INPUT
reasonCodes exclude CONTINUE_METRICS_ONLY
riskMetricsWithinLimits=false
systemAllowRiskIncrease=false
computed metrics=null
frozen plannedCap/dailyLossLimit/startDrawdownLimit retained
```

## 6. Changed files

```text
ALLOWED_WRITE_PATHS=src/risk/risk-engine.ts; src/risk/risk-input-validation.ts; src/risk/risk-input-parser.ts; src/risk/risk-types.ts=UNCHANGED; test/risk/risk-engine-corrective-2.test.ts; package.json test registration; docs/PHASE_2D_CONTRACT.md; docs/PHASE_2D_CORRECTIVE_2_EVIDENCE.md; docs/IMPLEMENTATION_CONTRACT.md status block; PR #3 body
FILES_ADDED=src/risk/risk-input-parser.ts; test/risk/risk-engine-corrective-2.test.ts; docs/PHASE_2D_CORRECTIVE_2_EVIDENCE.md
FILES_CHANGED=src/risk/risk-engine.ts; src/risk/risk-input-validation.ts; package.json; docs/PHASE_2D_CONTRACT.md; docs/IMPLEMENTATION_CONTRACT.md
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/persistence/** bytes; Phase 2C coordination; accepted Phase 1 simulator; venue adapters; execution coordinator; network/auth/signing; live mode; Phase 2E; Phase 2F; capital/leverage/risk limits; lockfile; zero-quantity policy
```

`src/persistence/**` is imported, not modified. Canonical serialization is reused as the single untrusted observation primitive.

## 7. Adversarial test matrix

```text
P2D-C2-01 null HALT PASS
P2D-C2-02 undefined HALT PASS
P2D-C2-03 primitives HALT PASS
P2D-C2-04 missing ownedActiveOrders HALT PASS
P2D-C2-05 ownedActiveOrders null/object/string HALT PASS
P2D-C2-06 unknownReservations non-array HALT PASS
P2D-C2-07 proposedBatch non-array HALT PASS
P2D-C2-08 malformed nested / class instance HALT PASS
P2D-C2-09 array element null/primitive/malformed HALT PASS
P2D-C2-10 throwing top-level getter HALT PASS
P2D-C2-11 throwing nested getter HALT PASS
P2D-C2-12 stateful getter reject-or-once PASS
P2D-C2-13 Proxy ownKeys throw HALT PASS
P2D-C2-14 Proxy getOwnPropertyDescriptor throw HALT PASS
P2D-C2-15 sparse/accessor array HALT PASS
P2D-C2-16 caller byte-identical no mutation PASS
P2D-C2-17 repeated malformed byte-identical PASS
P2D-C2-18 valid 150/-5/10/boundary unchanged PASS
P2D-C2-19 original 358-suite IDs remain PASS
P2D-C2-20 systemAllowRiskIncrease always false PASS
```

Tests construct hostile inputs with `as unknown`, `Object.defineProperty`, and `Proxy`.

## 8. Validation commands

```text
INSTALL_COMMAND=npm ci
INSTALL_EXIT=0
TYPECHECK_COMMAND=npm run typecheck
TYPECHECK_EXIT=0
LINT_COMMAND=npm run lint
LINT_EXIT=0
FORMAT_CHECK_COMMAND=npm run format:check
FORMAT_CHECK_EXIT=0
TEST_PHASE2A_TOTAL=73 PASS=73 FAIL=0 SKIP=0
TEST_PHASE2B_TOTAL=26 PASS=26 FAIL=0 SKIP=0
TEST_PHASE2C_TOTAL=30 PASS=30 FAIL=0 SKIP=0
TEST_PHASE2C_CORRECTIVE_TOTAL=25 PASS=25 FAIL=0 SKIP=0
TEST_PHASE2C_CORRECTIVE_2_TOTAL=10 PASS=10 FAIL=0 SKIP=0
TEST_PHASE2D_TOTAL=30 PASS=30 FAIL=0 SKIP=0
TEST_PHASE2D_CORRECTIVE_1_TOTAL=18 PASS=18 FAIL=0 SKIP=0
TEST_PHASE2D_CORRECTIVE_2_TOTAL=20 PASS=20 FAIL=0 SKIP=0
TEST_COMMAND=npm test
TEST_EXIT=0
TEST_TOTAL=378
TEST_PASS=378
TEST_FAIL=0
TEST_SKIP=0
TEST_TODO=0
TEST_CANCELLED=0
BUILD_COMMAND=npm run build
BUILD_EXIT=0
SECRET_SCAN_COMMAND=npm run scan:secrets
SECRET_SCAN_EXIT=0
SECRET_SCAN_RESULT=Secret scan passed (108 tracked files inspected).
DRY_RUN_COMMAND=npm run dry-run
DRY_RUN_EXIT=0
DRY_RUN_RESULT={"project":"multi-venue-grid-engine","runtimeMode":"DRY_RUN","liveExchangeWrites":false,"phase":0,"experimentSpecVersion":"0.1.0"}
AUDIT_COMMAND=npm audit --json
AUDIT_EXIT=0
AUDIT_VULNERABILITIES_TOTAL=0
DIFF_CHECK_COMMAND=git diff --check
DIFF_CHECK_EXIT=0
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITES=false
PHASE_2E_STARTED=NO
PRIOR_CUMULATIVE_TEST_TOTAL=358
TEST_TOTAL_GT_358=YES
```

## 9. Unresolved risks

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization
UNVERIFIED_ASSUMPTIONS=canonicalSerializeToUtf8 remains the exclusive untrusted observation path; sentinel evaluatedAt="0" is diagnostic-only
FOLLOW_UP_REQUIRED=independent review of Phase 2D Corrective 2; do not start Phase 2E, Gate 2, merge, or live testing
```

## 10. Prohibited-action attestation

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_API_KEY_USED=NO
TESTNET_TRADING_KEY_USED=NO
WITHDRAWAL_PERMISSION_USED=NO
THIRD_PARTY_SOURCE_COPIED=NO
MAIN_FORCE_PUSHED=NO
PRODUCTION_DEPLOYMENT=NO
NEXT_PHASE_STARTED=NO
RESET_REBASE_AMEND_FORCE_PUSH=NO
PHASE_2E_STARTED=NO
PHASE_2F_STARTED=NO
LOCKFILE_CHANGED=NO
ZERO_QUANTITY_POLICY_CHANGED=NO
```

## 11. Requested reviewer decision

```text
REQUESTED_DECISION=PASS
REQUESTED_GATE=PHASE_2D_CORRECTIVE_2
PHASE_2D_SELF_DECLARED_PASS=NO
```

This is only the implementation agent's request. The independent reviewer owns PASS / REJECT / BLOCKED.
