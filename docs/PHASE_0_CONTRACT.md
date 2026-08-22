# Phase 0 Implementation Contract

Contract version: `0.1.0`

This is the **only implementation phase currently authorized** for a new implementation agent.

Phase 0 establishes a deterministic TypeScript/Node repository baseline and proves that the project fails closed before any exchange integration exists.

## 1. Binding baseline

Repository:

```text
danny0971haha/multi-venue-grid-engine
```

Implementation branch:

```text
experiment/v0.1-phase0
```

Before editing, record:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff --check
node --version
npm --version
```

If the starting worktree is unexpectedly dirty, stop and report it. Do not reset or discard unknown work.

## 2. Frozen runtime toolchain

Use:

```text
Node.js 22.23.2
npm 10.9.8
TypeScript 7.0.2
module system: ESM
```

Reason for Node pin: as verified on 2026-08-22, Node `22.23.2` is an LTS release and the official Node v22 archive reports bundled npm `10.9.8`.

Reference:

- https://nodejs.org/en/about/previous-releases
- https://nodejs.org/en/download/release/latest-v22.x/
- https://nodejs.org/en/download/archive/v22

Use exact package versions in `package.json`; do not use `^`, `~`, `*`, `latest`, floating Git refs, or unpinned package-manager resolutions for project dependencies.

`package-lock.json` is mandatory and must be committed.

### 2.1 Dev tooling

Required capabilities:

- TypeScript compiler;
- TypeScript execution for tests/CLI where needed;
- lint;
- formatting check;
- Node built-in test runner or an equivalently minimal pinned test runner;
- secret-pattern baseline scan.

Preferred Phase 0 runner:

```text
tsx 4.23.12
node:test
```

Lint/formatter packages may be selected from maintained mainstream tools, but the selected exact versions must be pinned and then treated as baseline. Do not introduce a large framework merely for Phase 0.

## 3. TypeScript compiler policy

`tsconfig.json` must enable strict safety settings appropriate for a financial state machine:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "useUnknownInCatchVariables": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

Equivalent additional strict options are allowed. Do not weaken these listed options.

Use ESM consistently. Avoid mixed CommonJS/ESM behavior.

## 4. Required Phase 0 repository structure

The exact filenames may vary only where a tool requires it, but the logical structure must be recognizable:

```text
.github/
  workflows/
    ci.yml

scripts/
  check-secrets.*

src/
  bootstrap/
    runtimeMode.ts
  index.ts

test/
  bootstrap/
    runtimeMode.test.ts

.env.example
.editorconfig
.gitignore
.node-version
package.json
package-lock.json
tsconfig.json
<lint config>
<format config>
```

Do not create empty strategy/execution/venue modules containing pretend implementations.

## 5. Runtime mode contract

Phase 0 implements only a safe runtime-mode shell.

Canonical modes:

```ts
type RuntimeMode = "DRY_RUN" | "LIVE";
```

Default with no configuration:

```text
DRY_RUN
```

Phase 0 must have **no implementation capable of transmitting a trading mutation**.

If the user requests live mode in Phase 0, startup must fail non-zero with a stable machine-readable reason such as:

```text
LIVE_MODE_NOT_IMPLEMENTED
```

A successful `DRY_RUN` boot must not require exchange credentials or network access.

## 6. Configuration policy

`.env.example` contains variable names and safe examples only.

Phase 0 may define:

```text
RUNTIME_MODE=DRY_RUN
LOG_LEVEL=info
DATA_DIR=./data
```

Do not define real exchange secret variables yet unless they are comments documenting future scope. Do not implement credential loading/signing in Phase 0.

`.env`, private keys, credential files, generated state, logs, and local data must remain git-ignored.

## 7. Package scripts

Provide stable scripts so later agents and reviewers use one command vocabulary:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run dry-run
npm run scan:secrets
npm run check
```

`npm run check` must run the deterministic static/test suite and fail on the first or aggregate failure. It must not invoke a real exchange.

`npm run dry-run` must be network-independent in Phase 0.

## 8. Secret-scan baseline

Phase 0 secret scanning is defense-in-depth, not a claim that pattern scanning catches every credential.

At minimum:

- fail if tracked files include `.env` other than `.env.example`;
- fail on tracked `*.pem`, `*.key`, common private-key headers, obvious bearer-token/API-secret fixtures, or known high-confidence secret patterns;
- scan git-tracked files, not `node_modules`;
- do not print full matched secret material to CI logs;
- document false-positive suppression explicitly if needed.

GitHub-native secret scanning may be enabled independently; it does not replace local/CI checks.

## 9. CI contract

Replace `.github/workflows/README.md` placeholder with an actual workflow.

CI must run on:

```text
push to implementation branches
pull_request targeting main
```

Required CI stages:

```text
checkout
setup exact Node 22.23.2
npm ci
tool version print
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run scan:secrets
npm run dry-run
```

Use least-privilege workflow permissions. CI must not receive exchange secrets.

Do not add a deployment job.

## 10. Phase 0 smoke behavior

Running:

```bash
npm run dry-run
```

should produce deterministic, non-secret output stating at minimum:

```text
project = multi-venue-grid-engine
runtimeMode = DRY_RUN
liveExchangeWrites = false
phase = 0
experimentSpecVersion = 0.1.0
```

JSON output is preferred if a CLI output format is introduced.

No market price, account balance, fake PnL, or pretend exchange connection is required.

## 11. Required Phase 0 tests

At minimum test:

1. missing `RUNTIME_MODE` resolves to `DRY_RUN`;
2. explicit `DRY_RUN` resolves successfully;
3. unknown runtime mode is rejected;
4. `LIVE` startup is rejected with `LIVE_MODE_NOT_IMPLEMENTED`;
5. dry-run bootstrap performs zero network/exchange mutations;
6. frozen experiment metadata exposed by the bootstrap shell matches `0.1.0` and does not silently substitute different capital/leverage values if included;
7. environment parsing does not echo secrets.

Tests must be deterministic and require no Internet.

## 12. Allowed write paths

Phase 0 implementation is bounded to:

```text
.github/workflows/**
.editorconfig
.gitignore
.node-version
.env.example
package.json
package-lock.json
tsconfig.json
<lint/format config files>
scripts/**
src/bootstrap/**
src/index.ts
test/bootstrap/**
```

If the selected tooling strictly requires another root config file, it may be added only for Phase 0 tooling and must be listed explicitly in the evidence packet.

## 13. Forbidden write paths

Do not modify:

```text
AGENTS.md
AI_START_HERE.md
GITHUB_BOOTSTRAP.md
README.md
docs/**
```

Do not create in Phase 0:

```text
src/venues/**
src/execution/**
src/risk/**
src/storage/**
src/strategy/**
real exchange clients
signing/authentication code
live order/cancel/reduce functions
```

If a contract change is required, stop and request it rather than editing contract files on the implementation branch.

## 14. Explicitly forbidden actions

- no live order submission;
- no exchange cancellation;
- no position reduction/flatten request;
- no leverage mutation;
- no production/testnet trading credential use;
- no `curl | sh` bootstrap scripts from unreviewed third parties in CI;
- no force-push;
- no merge to `main`;
- no deployment;
- no modification of GitHub repository secrets;
- no copying third-party bot source.

## 15. Required validation commands

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
git diff --check
git status --short
```

Expected toolchain:

```text
node = v22.23.2
npm = 10.9.8
```

If exact Node/npm cannot be used in the implementation environment, do not silently proceed on a different runtime. Return `BLOCKED_TOOLCHAIN_MISMATCH` with evidence.

## 16. Gate 0 acceptance

The implementation agent does not grant this gate.

Independent reviewer may return `PASS` only when:

- exact runtime/toolchain proven;
- clean `npm ci` from lockfile succeeds;
- typecheck/lint/format/tests/build all pass;
- secret scan passes;
- dry-run is default;
- `LIVE` is explicitly unavailable;
- CI contains no deployment/live credential path;
- no contract files were changed;
- no real venue/write code was introduced;
- no live exchange write occurred.

## 17. Phase 0 handoff format

Return the full `docs/EVIDENCE_TEMPLATE.md` packet and include:

```text
REQUESTED_GATE=GATE_0
IMPLEMENTATION_PHASE=PHASE_0
BASE_SHA=<exact>
RESULT_SHA=<exact>
LIVE_EXCHANGE_WRITE=NO
NEXT_PHASE_STARTED=NO
```

Stop after handing off evidence.
