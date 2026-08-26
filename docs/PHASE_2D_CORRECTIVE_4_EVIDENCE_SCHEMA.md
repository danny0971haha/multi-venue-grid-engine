# Phase 2D Corrective 4 evidence schema

## Historical schema v1

Schema ID: `multi-venue-phase2d-corrective4/1`

Verifier schema ID: `multi-venue-phase2d-corrective4-verifier/1`

Schema v1 remains the historical meaning of evidence HEAD
`76171a19f3bc2ade35f4d86cbd9b591aaf90dc8b`. That head is independently
`PHASE_2D_CORRECTIVE_4_EVIDENCE_HEAD_DISPOSITION=REJECT`. This document does not
redefine v1 fields.

## Schema v2

Schema ID: `multi-venue-phase2d-corrective4/2`

Verifier schema ID: `multi-venue-phase2d-corrective4-verifier/2`

Schema v2 is the evidence-corrective-1 contract. It does not change risk
calculations. The generator must not write a gate verdict. The verifier must not
trust a generator verdict and must not read `requestedVerdict` or any
self-ACCEPT field.

Artifacts are written to gitignored `artifacts/phase2d-corrective4/` and must be
produced on the CI runner that checked out the candidate.

Generator semantic code lives in `scripts/evidence/phase2d-corrective4-lib.mjs`.
Verifier semantic code lives in `scripts/evidence/phase2d-corrective4-verify-lib.mjs`.
Shared constants live in `scripts/evidence/phase2d-corrective4-schema.mjs` and
must not contain parsers, evaluators, generators, verifiers, filesystem scans,
git commands, or safety decisions. The verifier entrypoint may import only the
verify library and the schema module.

## Files

```text
manifest.json
file-hashes.json
audit.json
logs/<command>.stdout.log
logs/<command>.stderr.log
verifier.json   # written only by the independent verifier
```

## Manifest keys (exact order, no additional properties)

```text
schema
identity
toolchain
commands
testFacts
auditFacts
safety
fileCommitment
testFileInventory
```

Forbidden keys anywhere in the manifest include `verdict`, `requestedVerdict`,
`requestedDecision`, `gateVerdict`, `gateDecision`, `selfDeclaredPass`,
`selfVerdict`, `reviewerDecision`, `accept`, `ACCEPT`, and `PASS`.

Generator and verifier output must not contain `PASS`, `ACCEPT`,
`requestedVerdict`, `requestedDecision`, `gateVerdict`, `gateDecision`, or
`selfDeclaredPass`.

### identity

```text
repository
sourceBranch
sourceHeadSha
sourceHeadTreeSha
testedCheckoutSha
testedCheckoutTreeSha
baseSha
implementationBaseSha
githubEventName
githubRunId
githubRunAttempt
githubJob
generatedAt
```

Every SHA is lowercase 40-hex. Every tree SHA must match `git rev-parse <sha>^{tree}`.
`generatedAt` and every command `startedAt` / `completedAt` must be ISO-8601 UTC
(`Date.parse` must not be `NaN`). `startedAt` must be `<= completedAt`.

`implementationBaseSha` is frozen at `c64fa291af0d53139c6c526cd25ede434c08c17b`
and must be an ancestor of both source HEAD and tested checkout.

Push:

```text
githubEventName === "push"
sourceHeadSha === GITHUB_SHA === git rev-parse HEAD === testedCheckoutSha
sourceBranch === GITHUB_REF_NAME
source HEAD must not differ from the tested checkout
```

Pull request:

```text
sourceHeadSha === pull_request.head.sha
sourceBranch === pull_request.head.ref
baseSha === pull_request.base.sha
testedCheckoutSha === GITHUB_SHA === git rev-parse HEAD
sourceHeadSha !== testedCheckoutSha
sourceHeadSha is an ancestor of testedCheckoutSha
source HEAD must not be impersonated by the merge checkout
```

Local:

```text
sourceHeadSha === testedCheckoutSha === git rev-parse HEAD
```

CI execution identity on push and pull_request:

```text
githubRunId === GITHUB_RUN_ID
githubRunAttempt === GITHUB_RUN_ATTEMPT
githubJob === GITHUB_JOB
run ID / attempt are canonical non-negative decimal integer strings
githubJob is non-empty
```

### toolchain

```text
nodeVersion    # must be v22.23.2
npmVersion     # must be 10.9.8
operatingSystem
architecture
```

### commands

Exact argv arrays, not prose. Each entry:

```text
name
argv
exitCode
stdoutFile
stderrFile
stdoutSha256
stderrSha256
startedAt
completedAt
```

Required commands, in order:

```text
npm run format:check
npm run lint
npm run typecheck
npm run test:phase2d-corrective-4
npm run test:evidence:phase2d-corrective4
npm test
npm run build
npm run scan:secrets
npm run dry-run
npm audit --omit=dev --json
```

The verifier reads `package.json` and requires these exact script bodies:

```text
test = tsx --test --test-reporter tap test/bootstrap/*.test.ts test/math/*.test.ts test/domain/*.test.ts test/strategy/*.test.ts test/simulator/*.test.ts test/persistence/*.test.ts test/risk/*.test.ts test/evidence/*.test.ts
test:phase2d-corrective-4 = tsx --test --test-reporter tap test/risk/risk-engine-corrective-4.test.ts
test:evidence:phase2d-corrective4 = node --import tsx --test --test-reporter=tap test/evidence/phase2d-corrective4-evidence.test.ts
dry-run = tsx src/index.ts
```

Removing the evidence suite from `npm test` fails closed. The verifier does not
trust manifest argv alone. On the canonical artifact directory it independently
reruns Corrective 4, the evidence verifier suite, the full test suite, audit,
and dry-run using verifier-owned argv.

### testFacts

```text
priorCumulativeTestTotal   # 428
corrective4.{total,pass,fail,skip,todo,cancelled}
evidenceVerifier.{total,pass,fail,skip,todo,cancelled}
full.{total,pass,fail,skip,todo,cancelled}
```

Totals are parsed from TAP summary comments in the recorded stdout logs. They
must not be handwritten into the verifier. Corrective 4 focused suite must
remain 15/15. `evidenceVerifier.total` is frozen at 46.
`full.total === 428 + evidenceVerifier.total`. fail, skip, todo, and cancelled
must be 0. `full.total >= 428` is not sufficient.

### auditFacts

Independently derived from `audit.json`. `auditZero` must not be a generator
constant.

```text
auditReportVersion         # 2
metadataCounts.{info,low,moderate,high,critical,total}
observedRowCounts.{info,low,moderate,high,critical,total}
metadataMatchesRows
vulnerabilityKeys
auditZero
```

This checkpoint requires audit zero: every metadata count is 0, observed row
counts are 0, `Object.keys(vulnerabilities).length === 0`, and
`metadata.total === info+low+moderate+high+critical`. Any vulnerability fails
closed. Counts must be finite non-negative safe integers.

### safety

Each boolean is derived from environment, dry-run stdout, workflow text, or
source/contract scans. A constant `false` in the generator is not sufficient.

```text
systemAllowRiskIncrease
liveExchangeWrite
productionCredentialUsed
testnetTradingKeyUsed
mergePerformed
deployPerformed
phase2EStarted
```

All must be `false` or generation/verification fails closed.

### fileCommitment

Sorted relative paths with SHA-256. Missing files, duplicates, absolute paths,
path traversal, and unsorted lists fail closed.

### testFileInventory

Sorted `{path, sha256, suite}` entries covering the files selected by the full
`npm test` globs. Suite classification is one of `bootstrap`, `math`, `domain`,
`strategy`, `simulator`, `persistence`, `risk`, `evidenceVerifier`. The inventory
must include `test/evidence/phase2d-corrective4-evidence.test.ts`. Duplicate
paths fail closed.

## Verifier

The verifier independently recomputes git identity, SHA/tree values, toolchain,
log hashes, TAP totals, audit JSON, file hashes, test-file inventory, safety
scans, schema, package.json scripts, and artifact completeness. It writes
`verifier.json` with `integrityOk`, `independentReview=NOT_PERFORMED`, and
`gateStatus=NOT_EMITTED`. It never emits ACCEPT or PASS.

Stdout is limited to:

```text
integrityOk=true|false
independentReview=NOT_PERFORMED
gateStatus=NOT_EMITTED
```
