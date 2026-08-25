# Phase 2D Corrective 4 Evidence Packet

Version: `0.2.0`

Checkpoint: evidence-corrective-1 for frozen Corrective 4 implementation

Requested reviewer decision: independent ACCEPT / REJECT / BLOCKED of evidence-corrective-1

The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_4=PASS`, `PHASE_2D_CORRECTIVE_4_EVIDENCE=PASS`, `PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=PASS`, or `GATE_2=PASS`.

```text
GATE_0=PASS
GATE_1=PASS
PHASE_2A=PASS
PHASE_2B=PASS
PHASE_2C_CORRECTIVE_2=PASS
CUMULATIVE_PHASE_2_BASELINE=PASS
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION=ACCEPT
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD=76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD_DISPOSITION=REJECT
PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_OVERALL=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
AUTHORITATIVE_START_HEAD=76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b
PRIOR_CUMULATIVE_TEST_TOTAL=428
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
EVIDENCE_VERIFIER_TOTAL=46
EXPECTED_FULL_TOTAL=474
LIVE_EXCHANGE_WRITES=false
liveExchangeWrite=false
productionCredentialUsed=false
mergePerformed=false
deployPerformed=false
phase2EStarted=false
```

Schema: `docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md` (`multi-venue-phase2d-corrective4/2`).

## 1. Identity

```text
PHASE=2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_4
CHECKPOINT=EVIDENCE_CORRECTIVE_1
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
PR_BASE=057732cee021889d17573425ee4f24e2065df1e9
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION=ACCEPT
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD=76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b
PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD_DISPOSITION=REJECT
PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
CUMULATIVE_PHASE_2_BASELINE=PASS
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
```

## 2. Toolchain

```text
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
```

Machine evidence records the exact Node/npm versions observed on the generating runner together with OS and architecture.

## 3. Frozen Corrective 4 implementation

Corrective 4 risk bytes remain frozen at `PHASE_2D_CORRECTIVE_4_IMPLEMENTATION_BASE`. This evidence-corrective-1 checkpoint does not modify:

```text
src/risk/risk-engine.ts
src/risk/risk-input-parser.ts
src/risk/risk-input-admission.ts
src/risk/risk-json-text.ts
src/risk/risk-types.ts
test/risk/**
capital / leverage / notional / loss / drawdown / boundary numeric limits
```

Object/raw UTF-8 budget parity, duplicate-key fail-closed, and unpaired-surrogate rejection remain as implemented in that base. The original Corrective 4 suite must stay 15 tests / 15 pass.

## 4. Evidence-corrective-1 behavior

1. `npm run evidence:phase2d-corrective4` generates `artifacts/phase2d-corrective4/` using spawn/execFile argv execution.
2. Required commands are recorded with exact argv, exit code, stdout/stderr files, SHA-256 hashes, and ISO-8601 UTC timestamps.
3. Test totals are parsed from TAP output. `priorCumulativeTestTotal=428`. `corrective4=15/15`. `evidenceVerifier=46/46`. `full.total === 428 + 46`. fail=skip=todo=cancelled=0.
4. Audit facts are independently derived. This checkpoint requires audit zero.
5. Safety attestations are derived from dry-run output, environment, workflow text, and source/contract scans.
6. Tracked file SHA-256 inventory and sorted test-file inventory are recorded.
7. `npm run evidence:phase2d-corrective4:verify` uses a separate semantic library. It binds GitHub event identity, recomputes hashes, TAP, audit, inventory, and safety, reads `package.json` script bodies, and independently reruns critical commands on the canonical artifact directory.
8. GitHub Action dependencies are pinned by immutable commit SHA. Push source HEAD equals tested checkout equals `GITHUB_SHA`. Pull-request source HEAD is `pull_request.head.sha` and must not be replaced by the merge checkout.
9. The generator does not write ACCEPT / PASS. The verifier writes `gateStatus=NOT_EMITTED`.

## 5. Changed files for evidence-corrective-1

```text
ALLOWED_WRITE_PATHS=.github/workflows/ci.yml; .github/workflows/README.md; .gitignore; package.json; scripts/evidence/**; test/evidence/**; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2D_CONTRACT.md
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/**; test/risk/**; test/persistence/**; test/simulator/**; lockfile; venue adapters; live mode; Phase 2E; frozen risk limits
```

## 6. Corrective 4 matrix (frozen implementation, still required)

```text
C4-01 structurally valid oversized object/raw parity
C4-02 exact 65535 canonical bytes object/raw parity
C4-03 exact 65536 canonical bytes object/raw parity
C4-04 exact 65537 canonical bytes object/raw parity
C4-05 raw ASCII padding 65535/65536/65537
C4-06 oversized multibyte UTF-8 within structural caps
C4-07 exact 65537 multibyte object/raw parity
C4-08 structurally invalid and oversized input
C4-09 oversized rejection deterministic
C4-10 no payload echo on limit failure
C4-11 duplicate equity keys fail closed before math
C4-12 escaped/nested duplicate keys fail closed
C4-13 sibling objects with the same key names remain valid
C4-14 unpaired surrogate JS string fails closed before parse
C4-15 in-budget valid object remains byte-identical
```

Evidence verifier cases live in `test/evidence/phase2d-corrective4-evidence.test.ts` (46 tests). At least one intact fixture is assembled by the test side without the generator library.

## 7. Unresolved risks

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization; evaluateRisk(unknown) is not DoS-proof against non-returning Proxy traps or process OOM; no worker isolation in this checkpoint
UNVERIFIED_ASSUMPTIONS=raw-byte API is the external trust boundary going forward; object API remains in-process only
FOLLOW_UP_REQUIRED=independent review of evidence-corrective-1; do not start Phase 2E, Gate 2, merge, live mode, or deploy
```

## 8. Prohibited-action attestation

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
liveExchangeWrite=false
productionCredentialUsed=false
mergePerformed=false
deployPerformed=false
phase2EStarted=false
PHASE_2D_SELF_DECLARED_PASS=NO
```

## 9. Requested reviewer decision

```text
REQUESTED_DECISION=independent ACCEPT or REJECT or BLOCKED
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2D_CORRECTIVE_4_IMPLEMENTATION=ACCEPT
PHASE_2D_CORRECTIVE_4_EVIDENCE_CORRECTIVE_1=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_OVERALL=REVIEW_CANDIDATE
```

This is only a request for independent review. The implementation agent does not declare the gate outcome.
