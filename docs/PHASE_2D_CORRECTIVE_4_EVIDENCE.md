# Phase 2D Corrective 4 Evidence Packet

Version: `0.2.0`  
Checkpoint: evidence closure for frozen Corrective 4 implementation  
Requested reviewer decision: independent ACCEPT / REJECT / BLOCKED of Phase 2D Corrective 4 **and** its evidence closure  
The implementation agent does **not** declare `PHASE_2D=PASS`, `PHASE_2D_CORRECTIVE_4=PASS`, `PHASE_2D_CORRECTIVE_4_EVIDENCE=PASS`, or `GATE_2=PASS`.

```text
CUMULATIVE_PHASE_2_BASELINE=PASS
PHASE_2C_CORRECTIVE_2=PASS
PHASE_2D_CORRECTIVE_2=ACCEPT
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_EVIDENCE=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2E_STARTED=NO
GATE_2=NOT_REVIEWED
SYSTEM_ALLOW_RISK_INCREASE=false
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
CORRECTIVE_4_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
AUTHORITATIVE_START_HEAD=c64fa291af0d53139c6c526cd25ede434c08c17b
AUTHORITATIVE_START_TREE=7eb995e35a65f94ab32921133e756268c0339a2d
HISTORICAL_CORRECTIVE_3_CANDIDATE=4af26dac5f2e50b335e998e925e0a1d97b4164b4
PRIOR_CUMULATIVE_TEST_TOTAL=428
TEST_PHASE2D_CORRECTIVE_4_TOTAL=15
LIVE_EXCHANGE_WRITES=false
liveExchangeWrite=false
productionCredentialUsed=false
mergePerformed=false
deployPerformed=false
phase2EStarted=false
```

Exact `EVIDENCE_CLOSURE_HEAD`, `EVIDENCE_CLOSURE_TREE`, CI run ID, artifact ID, and artifact digest are recorded on Draft PR #3 after the evidence-closure push. They are not self-declared as PASS.

Schema: `docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md` (`multi-venue-phase2d-corrective4/1`).

## 1. Identity

```text
PHASE=2D_CORRECTIVE_4_EVIDENCE_CLOSURE
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4_REVIEW
REPOSITORY=danny0971haha/multi-venue-grid-engine
IMPLEMENTATION_PHASE=2D_CORRECTIVE_4
CHECKPOINT=EVIDENCE_CLOSURE
BRANCH=experiment/v0.1-phase2
PR_NUMBER=3
PR_BASE=057732cee021889d17573425ee4f24e2065df1e9
CORRECTIVE_4_IMPLEMENTATION_BASE=c64fa291af0d53139c6c526cd25ede434c08c17b
AUTHORITATIVE_START_HEAD=c64fa291af0d53139c6c526cd25ede434c08c17b
AUTHORITATIVE_START_TREE=7eb995e35a65f94ab32921133e756268c0339a2d
WORKTREE_CLEAN_BEFORE=YES
PHASE_2D_CORRECTIVE_3=REJECT
PHASE_2D_CORRECTIVE_4=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_EVIDENCE=REVIEW_CANDIDATE
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2E_STARTED=NO
CUMULATIVE_PHASE_2_BASELINE=PASS
ACCEPTED_PHASE_1_HEAD=057732cee021889d17573425ee4f24e2065df1e9
```

`4af26dac5f2e50b335e998e925e0a1d97b4164b4` is the historical Corrective 3 candidate only. It is not the current candidate.

## 2. Toolchain

```text
PINNED_NODE_VERSION=v22.23.2
PINNED_NPM_VERSION=10.9.8
TYPESCRIPT_VERSION=7.0.2
```

Machine evidence records the exact Node/npm versions observed on the generating runner together with OS and architecture.

## 3. Frozen Corrective 4 implementation

Corrective 4 risk bytes remain frozen at `CORRECTIVE_4_IMPLEMENTATION_BASE`. This evidence-closure checkpoint does not modify:

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

## 4. Evidence closure behavior

1. `npm run evidence:phase2d-corrective4` generates `artifacts/phase2d-corrective4/` using spawn/execFile argv execution.
2. Required commands are recorded with exact argv, exit code, stdout/stderr files, SHA-256 hashes, and timestamps.
3. Test totals are parsed from TAP output. Prior cumulative total is 428. Full total must be >= 428 with fail=skip=todo=cancelled=0.
4. Safety attestations are derived from dry-run output, environment, workflow text, and source/contract scans.
5. Tracked file SHA-256 inventory is sorted by relative path.
6. `npm run evidence:phase2d-corrective4:verify` recomputes identity, toolchain, logs, TAP, hashes, audit JSON, schema, and attestations and fails closed on tamper.
7. GitHub Action dependencies are pinned by immutable commit SHA. Tested checkout follows the GitHub event checkout. Source HEAD and pull_request merge checkout are recorded separately.
8. The generator does not write ACCEPT / PASS. The verifier writes `gateStatus=NOT_EMITTED`.

## 5. Changed files for evidence closure

```text
ALLOWED_WRITE_PATHS=.github/workflows/ci.yml; .github/workflows/README.md; .gitignore; package.json; scripts/evidence/**; test/evidence/**; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md; docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md; docs/IMPLEMENTATION_CONTRACT.md; docs/PHASE_2D_CONTRACT.md
FILES_DELETED=NONE
INTENTIONALLY_UNTOUCHED_AREAS=src/**; test/risk/**; test/persistence/**; test/simulator/**; lockfile; venue adapters; live mode; Phase 2E; frozen risk limits
```

## 6. Corrective 4 matrix (frozen implementation, still required)

```text
C4-01 structurally valid oversized object/raw parity PASS
C4-02 exact 65535 canonical bytes object/raw parity PASS
C4-03 exact 65536 canonical bytes object/raw parity PASS
C4-04 exact 65537 canonical bytes object/raw parity PASS
C4-05 raw ASCII padding 65535/65536/65537 PASS
C4-06 oversized multibyte UTF-8 within structural caps PASS
C4-07 exact 65537 multibyte object/raw parity PASS
C4-08 structurally invalid and oversized input PASS
C4-09 oversized rejection deterministic PASS
C4-10 no payload echo on limit failure PASS
C4-11 duplicate equity keys fail closed before math PASS
C4-12 escaped/nested duplicate keys fail closed PASS
C4-13 sibling objects with the same key names remain valid PASS
C4-14 unpaired surrogate JS string fails closed before parse PASS
C4-15 in-budget valid object remains byte-identical PASS
```

Evidence verifier tamper cases live in `test/evidence/phase2d-corrective4-evidence.test.ts`.

## 7. Unresolved risks

```text
KNOWN_GAPS=Phase 2E durable halt/ACK unimplemented; Phase 2F restart integration unimplemented; CONTINUE is not live authorization; evaluateRisk(unknown) is not DoS-proof against non-returning Proxy traps or process OOM; no worker isolation in this checkpoint
UNVERIFIED_ASSUMPTIONS=raw-byte API is the external trust boundary going forward; object API remains in-process only
FOLLOW_UP_REQUIRED=independent review of Phase 2D Corrective 4 and evidence closure; do not start Phase 2E, Gate 2, merge, live mode, or deploy
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
REQUESTED_GATE=PHASE_2D_CORRECTIVE_4
PHASE_2D_SELF_DECLARED_PASS=NO
PHASE_2D_CORRECTIVE_4=REVIEW_CANDIDATE
PHASE_2D_CORRECTIVE_4_EVIDENCE=REVIEW_CANDIDATE
```

This is only a request for independent review. The implementation agent does not declare the gate outcome.
