# Phase 2D Corrective 4 evidence schema

Schema ID: `multi-venue-phase2d-corrective4/1`

This schema describes CI-generated machine evidence for Phase 2D Corrective 4
evidence closure. It does not change risk calculations. The generator must not
write a gate verdict. The verifier must not trust a generator verdict and must
not read `requestedVerdict` or any self-ACCEPT field.

Artifacts are written to gitignored `artifacts/phase2d-corrective4/` and must be
produced on the CI runner that checked out the candidate.

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
safety
fileCommitment
```

Forbidden keys anywhere in the manifest include `verdict`, `requestedVerdict`,
`requestedDecision`, `gateVerdict`, `gateDecision`, `selfDeclaredPass`,
`selfVerdict`, `reviewerDecision`, `accept`, `ACCEPT`, and `PASS`.

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

On `pull_request`, `sourceHeadSha` must equal `pull_request.head.sha` and must not
be replaced by the GitHub merge checkout SHA. On `push` or `local`, source HEAD
and tested checkout may be identical.

`implementationBaseSha` is frozen at `c64fa291af0d53139c6c526cd25ede434c08c17b`.

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
npm test
npm run build
npm run scan:secrets
npm run dry-run
npm audit --omit=dev --json
```

Commands are executed with `spawn` / `execFile` argv form. Untrusted values are
not concatenated into a shell command.

### testFacts

```text
priorCumulativeTestTotal   # 428
corrective4.{total,pass,fail,skip,todo,cancelled}
full.{total,pass,fail,skip,todo,cancelled}
```

Totals are parsed from TAP summary comments in the recorded stdout logs. They
must not be handwritten. Corrective 4 focused suite must remain 15/15.
Full total must be >= 428. fail, skip, todo, and cancelled must be 0.

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

## Verifier

The verifier recomputes git identity, toolchain, log hashes, TAP totals, file
hashes, audit JSON, safety scans, schema, and artifact completeness. It writes
`verifier.json` with `integrityOk`, `independentReview=NOT_PERFORMED`, and
`gateStatus=NOT_EMITTED`. It never emits ACCEPT or PASS.
