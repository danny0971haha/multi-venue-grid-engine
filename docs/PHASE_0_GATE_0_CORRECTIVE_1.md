# Phase 0 Gate 0 Corrective 1

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 0 REJECTED  
**Date:** 2026-08-22  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase0`  
**Rejected candidate:** `ccf8d872df0618a4d7cb766842ce7ac14326723d`  
**Rejected candidate tree:** `4ec2d3d340277e0d839bcba3e754a3b4c83e1bcd`  
**Authoritative contract baseline inspected:** `main@39c4befb547636e6de31b97aa340bf86b7fcf930`  
**Successful CI evidence:** run `32574248698`

## 1. Independent decision

```text
GATE_0=REJECT
PHASE_1_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

The Phase 0 implementation itself is close to the required deterministic baseline: the pinned toolchain, lockfile, strict checks, fail-closed runtime shell, secret scan, tests, build, dry-run, and CI are present and the exact candidate CI completed successfully.

Gate 0 cannot pass at the current bytes because the implementation branch is not synchronized with the current authoritative contract baseline and contains a prohibited/stale root `README.md` modification.

Implement only this corrective, then stop for independent review.

## 2. Rejection findings

### MV-G0-R1 — branch is behind and diverged from the authoritative contract baseline

At the rejected candidate:

```text
main=39c4befb547636e6de31b97aa340bf86b7fcf930
phase0=ccf8d872df0618a4d7cb766842ce7ac14326723d
merge-base=b1e035d07d94364138feedd34bda730dba70fb93
status=diverged
```

The current `main` contains the authoritative Phase 0 scope, domain contracts, fault matrix, acceptance gates, and review protocol. The Phase 0 branch must incorporate that baseline before Gate 0 can be accepted or Phase 1 can begin.

### MV-G0-R2 — root `README.md` violates current Phase 0 write scope

`docs/PHASE_0_CONTRACT.md` explicitly lists root `README.md` as a forbidden implementation write path.

The branch modifies it and currently states:

```text
Node.js 26.5.0
npm 11.17.0
```

while the actual accepted toolchain candidate is:

```text
Node.js 22.23.2
npm 10.9.8
```

It also describes stale runtime output/terminology. These bytes are both out of scope and operationally misleading.

Required correction:

- synchronize the branch with latest `origin/main`;
- resolve `README.md` by retaining the current authoritative `main` version;
- do not reapply the Phase 0 implementation's root README edits;
- prove that the final implementation diff does not modify any forbidden path relative to the synchronized contract baseline.

### MV-G0-R3 — PR is not currently mergeable

PR #1 is currently non-mergeable because the implementation branch and contract baseline diverged. Gate 0 requires a reproducible candidate tied to one unambiguous contract baseline.

Required correction:

- perform a normal, non-force synchronization merge from `origin/main` into `experiment/v0.1-phase0`;
- resolve only genuine merge conflicts;
- do not rewrite published history;
- after push, verify PR #1 is mergeable or report the exact remaining blocker.

## 3. Required execution sequence

Run from a clean checkout:

```bash
git fetch --all --prune
git checkout experiment/v0.1-phase0
git status --short
git rev-parse HEAD
git rev-parse origin/main
```

Expected pre-corrective identities at contract creation time:

```text
phase0 candidate = ccf8d872df0618a4d7cb766842ce7ac14326723d
main before this corrective document = 39c4befb547636e6de31b97aa340bf86b7fcf930
```

Then synchronize without rewriting history:

```bash
git merge --no-ff origin/main
```

Conflict policy:

1. `README.md`: keep the current `origin/main` content.
2. Contract documents under `docs/**`: keep reviewer-authored `origin/main` content, including this corrective contract.
3. Phase 0 implementation files: preserve the accepted-intent implementation only where allowed by `docs/PHASE_0_CONTRACT.md`.
4. Do not resolve a conflict by weakening the current contract, deleting tests, changing frozen values, or restoring Node 26/npm 11.
5. If any conflict cannot be resolved within these rules, stop with `BLOCKED_CONTRACT_BASELINE_CONFLICT` and provide the exact paths.

## 4. Allowed final implementation diff

Relative to the synchronized authoritative `main`, the Phase 0 candidate may modify/add only the paths allowed by `docs/PHASE_0_CONTRACT.md`, including tooling-required equivalents:

```text
.github/workflows/**
.editorconfig
.gitignore
.node-version
.nvmrc
.npmrc
.env.example
package.json
package-lock.json
tsconfig.json
tsconfig.build.json
biome.json
scripts/**
src/bootstrap/**
src/index.ts
test/bootstrap/**
```

The implementation agent must not modify:

```text
AGENTS.md
AI_START_HERE.md
GITHUB_BOOTSTRAP.md
README.md
docs/**
```

Reviewer-authored contract changes inherited through the merge are not implementation changes; do not edit them during the corrective.

## 5. Required current-byte checks

After synchronization, prove:

```text
node=v22.23.2
npm=10.9.8
TypeScript=7.0.2
runtime default=DRY_RUN
explicit LIVE=LIVE_MODE_NOT_IMPLEMENTED
network/exchange mutations in Phase 0=absent
production/testnet credentials used=NO
```

Run and report exact exit codes:

```bash
node --version
npm --version
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run scan:secrets
npm run dry-run
RUNTIME_MODE=LIVE npm run dry-run
git diff --check
git status --short
```

Expected `LIVE` command result:

```text
non-zero exit
stable reason includes LIVE_MODE_NOT_IMPLEMENTED
no network or exchange mutation
```

Also run:

```bash
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

The changed-file list must not contain a forbidden implementation path.

## 6. CI requirement

Push bounded corrective commits only to:

```text
experiment/v0.1-phase0
```

Wait for GitHub Actions on the exact candidate HEAD. Report:

```text
workflow run ID
head SHA
status
conclusion
```

CI must contain no deployment, exchange secret, authentication/signing, or trading job.

## 7. Prohibited actions

```text
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_OR_TESTNET_CREDENTIAL_USE=NO
PHASE_1_STARTED=NO
REAL_VENUE_ADAPTER=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
FORCE_PUSH=NO
CONTRACT_EDIT_BY_IMPLEMENTER=NO
```

Do not add `decimal.js`, domain models, grid logic, or simulator code in this corrective. Those belong to Phase 1 after Gate 0 independently passes.

## 8. Evidence packet

Stop after the corrective and return:

```text
CHECKPOINT=PHASE_0_GATE_0_CORRECTIVE_1
STATUS=<READY_FOR_REVIEW|BLOCKED>
REPOSITORY=danny0971haha/multi-venue-grid-engine
BRANCH=experiment/v0.1-phase0
BASE_SHA=ccf8d872df0618a4d7cb766842ce7ac14326723d
SYNCED_MAIN_SHA=<exact origin/main merged>
HEAD_SHA=<candidate>
TREE_SHA=<candidate tree>

MERGE_EVIDENCE:
<merge commit and conflict resolutions>

CHANGED_FILES_VS_SYNCED_MAIN:
<exact list>

VALIDATION:
<commands, exit codes, test totals>

CI_EVIDENCE:
<RUN_ID, HEAD_SHA, STATUS, CONCLUSION>

SCOPE_EVIDENCE:
README_MODIFIED_BY_IMPLEMENTATION=NO
CONTRACT_DOCS_MODIFIED_BY_IMPLEMENTATION=NO
FORBIDDEN_PATH_DIFFS=NONE

DRY_RUN_EVIDENCE:
<default DRY_RUN output and LIVE fail-closed output>

SECRET_SCAN:
<result; never print secret values>

PROHIBITED_ACTION_ATTESTATION:
LIVE_EXCHANGE_WRITE=NO
PRODUCTION_OR_TESTNET_CREDENTIAL_USE=NO
PHASE_1_STARTED=NO
DEPLOYMENT=NO
MERGE_TO_MAIN=NO
FORCE_PUSH=NO

KNOWN_LIMITATIONS:
<explicit list>

REQUESTED_VERDICT=<PASS|REJECT|BLOCKED>
```

The implementation agent must not self-declare Gate 0 PASS. After returning the evidence packet, stop.