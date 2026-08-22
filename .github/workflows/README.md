# CI

`ci.yml` is the Phase 0 baseline workflow. It performs a clean lockfile install, formatting and
lint checks, typechecking, tests, a repository secret scan, and a production TypeScript build.

It runs for every branch push and pull request. Required acceptance checks remain defined in
`docs/ACCEPTANCE_GATES.md`; an independent reviewer owns the Gate 0 decision.
