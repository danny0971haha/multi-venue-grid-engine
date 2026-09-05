# Trusted Phase 2D supported-base corrective

Date: 2026-09-05. Separate governance checkpoint; not a runtime rebind.
Base main: `22665d7fa9274dfc05de043c8e9663e24e75087e`.
Base tree: `6981c1124524895273fb09b53d769ca9dbb722bc`.
Branch: `fix/multi-trusted-base-scope-20260905`.

## Problem and bounded change

The workflow ran for every PR base but checked out `pull_request.base.sha`.
The tooling base at `968ea3b201cd5be58f54df64a02ae29d4ed9ab75` has no
`scripts/governance/phase2d-trusted-gate.mjs`, causing MODULE_NOT_FOUND in
run [33950204339](https://github.com/danny0971haha/multi-venue-grid-engine/actions/runs/33950204339).

The existing classifier explicitly describes PRs targeting main. The currently
active [ruleset 21580900](https://github.com/danny0971haha/multi-venue-grid-engine/rules/21580900)
includes only `refs/heads/main` and requires `trusted-phase2d-freeze-gate`
plus the ordinary CI context. This was read through GitHub on 2026-09-05.
No repository rules or protection settings are changed.

Add only `branches: [main]` to this workflow's pull_request_target trigger.
All event types, permissions, Action pins, exact protected base checkout,
classifier, integrity checker, candidate pins and final fail-closed mode handling
remain unchanged. No code from a PR head is introduced into trusted execution.

| Target base | Proposed trigger |
| --- | --- |
| main, including a fork PR targeting main | Run existing gate unchanged |
| tooling/documentation/other branch | Do not trigger this main-only gate |
| Retargeted to main with edited event | Run existing gate unchanged |

The filter narrows applicability, not acceptance for any candidate. It does not
produce a successful gate context for non-main PRs. Any separate branch-protection
or future ruleset requiring this context on another base must be reviewed before
adopting this policy; inaccessible legacy protection is not certified absent.
Ordinary CI remains independent. Runtime/frozen identity acceptance does not
transfer when a tooling branch eventually targets main.

## Verification and evidence limits

The workflow diff is exactly one added trigger line. Its two hashes in the
trusted governance file inventory are refreshed to those exact bytes; every
candidate binding, protected file and other inventory entry remains unchanged. The entire jobs mapping,
permissions, concurrency and event type list compare unchanged; base matching
was checked for main, tooling and fork-head/main-base cases. No new execution
path, gate mode, baseline or test total was added. This is static verification,
not a GitHub dispatch simulation or independent governance acceptance.

This checkpoint uses GitHub Git Data API with the exact base tree and two entries
(the workflow and this note), rather than claiming a full local main checkout.
Node v24.19.0/npm 11.9.0 are the available local tools; pinned install, runtime,
governance regression suite, build, dry-run, secret scan and deployed trigger
behavior are NOT_RUN here. Result SHA/tree are recorded in the PR handoff.

The original workflow continues to execute until a separately approved merge;
a draft PR cannot fix currently executing pull_request_target behavior. No merge
was performed or authorized by this implementation.

Preserved refs observed on GitHub: Phase 2D
`7f196d367e39640eee9517f742b0d61424f9d4cc`, Phase 2E runtime
`704afa2dd858c52dad06aa22941d463aa5ce4d69`, Phase 2E governance
`52445f4c2b3eb65f13ae00dbef80f07b417a7d53`.
No credentials, exchange writes, settings changes, force-push, deployment,
third-party source import or new phase. No self-declared gate decision.

## First corrective CI

At `f1347c2bd081303249586f18ce962d59a51c6fef`, ordinary CI and the main
trusted classification completed successfully. Governance run `33964968438`
completed 78 tests with 0 failed/skipped/todo, then the unchanged generator
correctly detected the stale workflow blob/SHA-256 inventory entry. The follow-up
updates only those two values from independently calculated current workflow
bytes, matching the generator diff. No candidate identity is rebound. The
original failure remains part of the record; new-SHA CI must verify idempotence.
