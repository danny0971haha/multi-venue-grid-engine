# Validation guide

These are distinct evidence classes. Success in one never implies success in another.

| Evidence class | Entrypoint | Meaning and limit |
| --- | --- | --- |
| Full local/CI validation | `npm run ci` | Format check, lint, typecheck, `npm test`, secret scan, build, dry-run. The same steps run in `.github/workflows/ci.yml`. |
| Product tests | `npm test` | Every product suite: bootstrap, math, domain, strategy, simulator, persistence, risk, halt/ACK/crash, telemetry/manifest, execution coordinator, offline integration. Expects 0 fail/cancelled/skip/todo. |
| Focused suites | `npm run test:phase3`, `npm run test:phase2f`, `npm run test:phase2e`, `npm run test:offline-integration`, `npm run test:phase2d*` | Subsets of `npm test` for faster iteration. |
| Offline simulation | `npm run simulate:offline-integration` | Deterministic fake-only wiring of existing modules with replay hashes. Not production orchestration or a new phase. |
| Historical evidence bytes | `npm run verify:candidate-evidence`, `npm run test:candidate-evidence` | Optional. Verifies the retained `docs/evidence/current-candidate/` packet is byte-intact. |
| Testnet/live authorization | Separate owner/reviewer decision | Absent. No command here grants it. |

## Environment

Use the repository pins, Node **22.23.2** and npm **10.9.8** (`.node-version`, `.npmrc` `engine-strict`), and the unmodified `package-lock.json`. A pinned-toolchain mismatch is a failure, not permission to upgrade or loosen checks. Report results from any other toolchain as diagnostic only.

```sh
npm ci
npm run ci
```

Tests are fake-only: no credentials, no `.env*` files other than `.env.example`, and no exchange networking. Test counts change as tests are added; record the observed totals in evidence rather than pinning them.

## Offline integration coverage

```sh
npm run simulate:offline-integration
npm run test:offline-integration
```

The fixed fixture in `test/offline-integration/scenarios.ts` flows through the existing grid geometry and intent generator, risk evaluator, Phase 2E continuation authority, lease-fenced fake execution, execution observation, checksummed exact-pair persistence, reload and ownership/execution reconciliation. It reports the full simulator snapshot plus continuation-decision canonical hash and repeats the fixture to compare hashes. Host-local process IDs, lease nonces and temporary directories are excluded from this explicitly named economic-state hash; no persisted economic fields are dropped.

Additional scenarios assert duplicate market/planning observations and duplicate executions have one economic effect; UNKNOWN remains unresolved; stale data, process fence, expired/mismatched lease, persistence latch and unresolved durable exposure block risk increase; durable HALT survives a fresh child process; restart does not acknowledge it; wrong/missing IDs and unsafe snapshot authority cannot ACK; valid existing durable conditions can commit ACK. These assertions call the current product modules. The harness-local deduplication map is test orchestration, not a new production execution coordinator.

The fresh-process worker receives only the temporary state directory, reloads durable authority, acquires its own lease and checks the stored halt before exercising missing/valid ACK. It does not reuse parent memory. This is a clean restart case; it does not replace the historical SIGKILL crash matrix, and makes no new crash-window claim.

Simulation output includes `mode=OFFLINE_INTEGRATION`, `liveExchangeWrites=false`, `networkAccessRequired=false`, `replayDeterministic`, `authorizationGranted=false`, fixture hash and canonical state hashes. It grants no acceptance, deployment, merge or live authority.

## Independent review boundary

Green validation is engineering evidence, not independent acceptance, deployment, merge or live authority. Retain historical documents. Read [CURRENT_STATUS.md](CURRENT_STATUS.md) for the timeline, and distinguish recorded historical acceptance, current engineering evidence, independent review, and operator authorization.
