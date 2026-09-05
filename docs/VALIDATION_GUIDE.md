# Candidate validation guide

These are distinct evidence classes. Success in one never implies success in another.

| Evidence class | Entrypoint / authority | Meaning and limit |
| --- | --- | --- |
| Frozen regression | `npm test` | Exact historical expansion; bound runtime baseline expects 474 pass, 0 fail/cancelled/skip/todo. No halt-suite substitution. |
| Phase 2E runtime | `npm run test:phase2e` | Existing dedicated halt/ACK/crash suite; expects 79 pass, 0 fail/cancelled/skip/todo. Does not establish Phase 2E acceptance. |
| Developer umbrella | `npm run validate:phase2e-candidate` | Sequential local reproduction of the nine existing commands; first mandatory failure stops execution. Never a trusted gate. |
| Trusted governance | Exact governance commit and live `.github/trusted/phase2e-corrective3-baseline.json` | Candidate classification, exact SHA/tree and protected-path checks, followed by trusted commands and exact counts. Remains bound to runtime `704afa2dd858c52dad06aa22941d463aa5ce4d69`. |
| Offline integration | `npm run simulate:offline-integration`; `npm run test:offline-integration` | Deterministic fake-only wiring of existing modules, new assertions and real fresh-process reload. Not production orchestration or a new phase. |
| Testnet/live authorization | Separate operator/reviewer decision | Absent. No command here grants it. |

## Environment and umbrella

Use the repository pins, Node **22.23.2**, npm **10.9.8**, and the unmodified package-lock.json. New wrappers additionally require Linux, Python 3 and `libseccomp.so.2`. They fail before executing workloads when kernel network isolation is unavailable. Only AF_UNIX sockets are allowed; inherited filtering covers child processes/native modules as well as JavaScript. No network or credential fallback exists. A credential-free checkout without `.env*` files other than `.env.example` is required. Caller environment is allowlisted to PATH; child HOME is temporary.

```sh
npm run validate:phase2e-candidate
```

The exact order remains:

```text
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:phase2e
npm run build
npm run scan:secrets
npm run dry-run
```

Installation uses npm's offline mode, no registry audit/funding requests, and does not disable engine-strict or alter versions/lifecycle scripts. Populate a trusted local dependency cache separately if needed and pass `-- --cache /absolute/path/to/cache`; this task cannot download packages through the offline wrapper. Missing dependencies or pinned toolchain mismatch are failures, not permission to upgrade or loosen checks. Logs, real exit codes, log hashes, candidate HEAD/tree and working-tree status are emitted in JSON. A dirty checkout is working-tree evidence, not proof of HEAD alone. Logs live under `artifacts/offline-candidate/`.

The wrapper validates the 474/79 totals without changing either command, trusted baseline, or count policy. New integration tests live in `test/offline-integration/`, outside both historical globs. Existing `npm run dry-run` still only checks bootstrap/runtime-mode behavior.

The implementation environment supplied Node 24.19.0/npm 11.9.0: the pinned `npm ci` failed with `EBADENGINE`. Any supplementary execution using available tooling must be reported as diagnostic evidence, not the pinned validation result.

## Offline integration coverage

```sh
npm run simulate:offline-integration
npm run test:offline-integration
npm run test:validation-tooling
```

The fixed fixture in `test/offline-integration/scenarios.ts` flows through the existing grid geometry and intent generator, risk evaluator, Phase 2E continuation authority, lease-fenced fake execution, execution observation, checksummed exact-pair persistence, reload and ownership/execution reconciliation. It reports the full simulator snapshot plus continuation-decision canonical hash and repeats the fixture to compare hashes. Host-local process IDs, lease nonces and temporary directories are excluded from this explicitly named economic-state hash; no persisted economic fields are dropped.

Additional scenarios assert duplicate market/planning observations and duplicate executions have one economic effect; UNKNOWN remains unresolved; stale data, process fence, expired/mismatched lease, persistence latch and unresolved durable exposure block risk increase; durable HALT survives a fresh child process; restart does not acknowledge it; wrong/missing IDs and unsafe snapshot authority cannot ACK; valid existing durable conditions can commit ACK. These assertions call the current product modules. The harness-local deduplication map is test orchestration, not a new production execution coordinator.

The fresh-process worker receives only the temporary state directory, reloads durable authority, acquires its own lease and checks the stored halt before exercising missing/valid ACK. It does not reuse parent memory. This is a clean restart case; it does not replace the historical SIGKILL crash matrix, and makes no new crash-window claim.

Simulation output includes `mode=OFFLINE_INTEGRATION`, `liveExchangeWrites=false`, `networkAccessRequired=false`, `replayDeterministic`, `authorizationGranted=false`, fixture hash and canonical state hashes. It grants no acceptance, deployment, merge or live authority.

## Independent review boundary

Governance remains on its separate branch; no trusted files or protected runtime bytes are modified here. New package script keys and new paths create a different candidate from the exact trusted runtime pin. The current trusted gate is expected not to accept arbitrary new tooling bytes under that pin. A separately reviewed future governance decision is required before binding another candidate; do not weaken SHA/tree/path/count checks to make this branch green.

Retain historical documents. Read [CURRENT_STATUS.md](CURRENT_STATUS.md) for the timeline, and distinguish recorded historical acceptance, current engineering evidence, independent review, and operator authorization. Stop after implementation/evidence; do not begin another phase.
