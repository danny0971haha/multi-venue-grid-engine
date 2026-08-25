# CI

`ci.yml` is the Phase 0 baseline workflow plus Phase 2D Corrective 4 schema-v2
machine-evidence closure. GitHub Action **dependencies** are pinned by immutable
commit SHA:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0)
- `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` (v7.0.1)

`persist-credentials` is `false`. Permissions remain `contents: read`.

The **tested checkout** follows the GitHub event checkout (including the
pull_request merge checkout when GitHub creates one). It is not rewritten to a
floating tag.

The **source HEAD** is recorded separately from that tested checkout:

- `pull_request`: source HEAD is `github.event.pull_request.head.sha`; tested
  checkout is the event merge checkout (`github.sha`). They must differ, and
  source HEAD must be an ancestor of the merge checkout.
- `push`: source HEAD, tested checkout, and `GITHUB_SHA` must be the same
  commit. `sourceBranch` must equal `GITHUB_REF_NAME`.

The workflow performs a clean lockfile install on Node.js `v22.23.2` / npm
`10.9.8`, then typecheck, lint, format check, tests, production build, secret
scan, dry-run, Corrective 4 evidence generation, independent evidence
verification, and schema-v2 artifact upload (`if-no-files-found: error`,
`retention-days: 90`). Generated files under `artifacts/` are not committed.

Required acceptance checks remain defined in `docs/ACCEPTANCE_GATES.md`. An
independent reviewer owns gate decisions. This workflow does not emit ACCEPT /
PASS.
