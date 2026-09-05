# AGENTS.md — Binding Implementation Instructions

This file is binding for any AI or human implementing this repository. It is model-neutral: a different model does not grant additional authority.

## Mission

Build an **independent, from-scratch multi-venue perpetual grid engine** that can eventually be tested under the frozen 100U experiment envelope in `docs/EXPERIMENT_SPEC.md`.

The immediate task is engineering and dry-run validation only. **Do not perform live exchange writes.**

## Current task routing

Start with [CURRENT_STATUS.md](docs/CURRENT_STATUS.md) and the impact-based reading map in [AI_START_HERE.md](AI_START_HERE.md). Establish the actual Git identity and the operator's current objective before choosing an implementation contract. Reading order is not authority order: apply [REVIEW_CHANGE_PROTOCOL.md](docs/REVIEW_CHANGE_PROTOCOL.md) for precedence and material conflicts. Status documents locate candidates and evidence; they do not grant acceptance or permissions.

Historical phase instructions do not restart bootstrap work. Long-term architecture requirements are not an instruction to implement deferred features. Phase entry still requires the applicable gate and an explicitly scoped task; never begin another phase automatically.

## Third-party boundary

- Do not fork `discountry/ritmex-bot` or any other trading bot into this repository.
- Do not copy third-party source files, code blocks, tests, fixtures, comments, or generated artifacts unless a compatible license is explicitly verified and the user separately authorizes the import.
- The reference repository `discountry/ritmex-bot` currently has no detected repository license in GitHub metadata as of the frozen research baseline. Treat its source as **read-only behavioral research**, not importable code.
- General ideas, public API documentation, exchange specifications, state-machine concepts, and independently designed algorithms may be used.
- Keep an attribution/research note for external concepts, but implementation bytes must be independently authored.

## Working rules

1. Work only on a feature branch. Never commit implementation directly to `main`.
2. Preserve `main` as the reviewable architecture/baseline branch. Never move frozen/runtime/governance refs or automatically rebind a trusted candidate.
3. Before changing code, record:
   - current branch, HEAD SHA and tree SHA;
   - working-tree status and relevant expected/observed candidate refs;
   - toolchain versions, allowed write paths and required validations.
   Inspect applicable repository and accessible workspace instructions. Report inaccessible settings or unavailable local state; do not invent them. Stop affected work on an unexplained identity mismatch or conflicting user changes.
4. Use bounded checkpoints. One checkpoint has one primary engineering objective, which may require several related files and correction iterations.
5. Do not mix UI polish with safety-critical execution changes.
6. Never weaken a fail-closed guard just to make a test pass.
7. Never claim live readiness from green CI alone.
8. Never create or use API keys with withdrawal permissions.
9. Secrets must not appear in git history, tests, telemetry, screenshots, logs, fixtures, or review artifacts.
10. If a required exchange fact cannot be verified, fail closed or leave the venue unsupported.
11. Keep Classic and Multi as independent repositories, branches, commits and evidence. Do not introduce a shared cross-repository runtime or copy Classic implementation into this project.

## Autonomous execution within scope

Analysis/review-only requests are read-only: do not edit files, commit, push or change repository settings. An implementation request authorizes only its stated scope and permitted actions, not merge, deployment, credentials or exchange access.

For an authorized objective, carry the work through impact analysis, root-cause diagnosis, implementation, relevant tests, in-scope corrections, documentation and final self-review. Do not stop at a plan or ask for another prompt for ordinary implementation details or related defects you can resolve within scope. Choose naming, function boundaries and necessary local refactoring yourself. Prefer the smallest coherent, maintainable correction, not the fewest changed characters. Respect every task-specific allowlist and byte-preservation requirement.

Classify failures as implementation, test, environment or contract problems using evidence. Fix your own in-scope type, format and test failures and rerun affected checks. Select the pinned toolchain only within permitted environment operations; do not relax engine checks, edit locks or add dependencies to accommodate the available machine. Dependency or contract changes still require the existing review protocol.

Pause the affected operation when an external fact, permission, protected path or material contract decision is required. Keep the checkpoint blocked where the protocol requires it; safe independent diagnosis is not permission to continue disputed implementation. Return the exact blocker, evidence, completed work and smallest proposed resolution. Do not edit these instructions, contracts, tests or gate criteria to bypass a blocker. Instruction changes require an explicitly authorized instruction-change task.

## Mandatory architecture

Keep these responsibilities separate:

- `core/domain` — types, order/position/execution identities, grid-level state machine.
- `strategy/grid` — grid geometry and desired strategy transitions only.
- `execution` — intent coordination, idempotency, ownership, reconciliation.
- `risk` — exposure, loss, drawdown, stale-data, boundary and kill-switch decisions.
- `venues` — exchange-specific protocol/adapters.
- `storage` — durable state, checksums/generations, runtime fencing.
- `telemetry` — append-only evidence events and run manifests.
- `cli` / `ui` — operational surfaces; never own trading truth.

Do not let exchange adapters contain strategy policy. Do not let UI state control authoritative risk state.

## Required v0.1 safety semantics

These are design requirements, not claims that every capability is implemented, and not authorization to implement deferred trading features in the current task.

- Dry-run is the default.
- Live mode must require explicit double opt-in plus a commit-bound canary acknowledgement.
- Only one runtime may own an experiment scope at a time; use a durable runtime lease/fencing generation.
- Restart must reconcile exchange state before any new risk-increasing order.
- Unknown/orphan orders are surfaced and block live reseeding until resolved.
- Authoritative `FILL` requires exchange-observed execution evidence. Open-order disappearance alone is not a fill.
- Partial fills must preserve executed quantity, remaining quantity, order identity, and execution identity where available.
- Duplicate logical orders must be deterministically reconciled.
- Hard risk breach: stop new risk -> cancel owned grid orders -> actively reduce/flatten -> fresh snapshot verify -> persist HALTED.
- Failed/ambiguous cancel or reduction remains HALTED.
- Hard halt cannot auto-restart. Resume requires a unique halt acknowledgement tied to the current halt instance.
- Missing/stale live equity, position, PnL, or execution data fails closed.
- Actual notional above cap must not degrade into cancel-only behavior; it requires bounded active reduction or a hard halt/flatten path.
- Uncaught fatal process errors must not be logged-and-ignored while trading continues. Fence writes and terminate or otherwise prove a fail-closed supervisor path.

## Validation, self-review and parallel work

Use [VALIDATION_GUIDE.md](docs/VALIDATION_GUIDE.md) and the required task/gate checks. Preflight the pinned tools, clean credential-free environment and required local IPC/isolation before validation. Preserve offline isolation and wrapper fail-fast behavior. A stopped wrapper may be diagnosed separately; skipped stages are not successes. Do not delete safety tests, reduce required totals, weaken assertions, replace real crash tests with exceptions, or use non-pinned diagnostic runs as gate evidence.

Before handoff, inspect the final diff and relevant counterexamples: malformed/stale input, duplicate events, partial/ambiguous outcomes, crash/restart and uncertain lease/persistence/ACK authority. Check only the applicable semantics, while retaining every mandatory matrix case. Verify the reported HEAD/tree, changed paths, evidence hashes and refs; distinguish fixed-object verification from branch-ref verification. Preserve original logs and historical evidence.

When tools support it, parallelize read-only audits or explicitly non-overlapping work within the same authorization boundary. Assign file ownership and one integration owner; use isolated worktrees where editing is allowed. Subagents get no additional permissions. Do not create competing edits, share commits across repos, or merge/rebase automatically. Rerun affected validations after any separately authorized integration. Self-review and subagent review are not the formal independent gate.

## Required handoff after every checkpoint

Return the exact packet in `docs/EVIDENCE_TEMPLATE.md` including current bytes, diff, tests, unresolved risks, and explicit statement that no live exchange write occurred. Internal correction iterations do not each require a new formal checkpoint packet unless the task requires one; the final packet must retain the actual failed, blocked and successful command evidence.

Report executed, not executed, failed and blocked checks separately. Never fabricate toolchain, test counts, hashes, remote state or acceptance. Stop after the authorized objective and evidence delivery; do not start another phase.

The independent reviewer, not the implementation agent, decides PASS / REJECT / BLOCKED.
