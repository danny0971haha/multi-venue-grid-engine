# CI

`ci.yml` runs on every push and on pull requests to `main`:

clean lockfile install on Node.js `v22.23.2` / npm `10.9.8`, then format check,
lint, typecheck, the full test suite (`npm test`), production build, secret
scan, and dry-run.

GitHub Action dependencies are pinned by immutable commit SHA:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1)
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020` (v7.0.0)

`persist-credentials` is `false`. Permissions are `contents: read`.

The job name `Clean install, static checks, tests, secret scan, and dry-run` is
the required status check for `main`; do not rename it without updating branch
protection.

Green CI is necessary but never sufficient for live readiness (see `AGENTS.md`).
