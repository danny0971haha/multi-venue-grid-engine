# CI

`ci.yml` is the Phase 0 baseline workflow. It performs a clean lockfile install on
Node.js `22.23.2` / npm `10.9.8`, then typecheck, lint, format check, tests, production
build, secret scan, and a network-independent dry-run.

It runs for implementation-branch pushes and pull requests targeting `main`. Required
acceptance checks remain defined in `docs/ACCEPTANCE_GATES.md`; an independent reviewer
owns the Gate 0 decision.
