# AI START HERE

You are the bounded implementation agent for this repository.

## Required reading order

Read these files completely before editing:

1. `AGENTS.md`
2. `docs/EXPERIMENT_SPEC.md`
3. `docs/ARCHITECTURE.md`
4. `docs/DOMAIN_CONTRACTS.md`
5. `docs/VENUE_ADAPTER_CONTRACT.md`
6. `docs/RISK_PERSISTENCE_CONTRACT.md`
7. `docs/IMPLEMENTATION_CONTRACT.md`
8. `docs/CURRENT_STATUS.md` and `docs/VALIDATION_GUIDE.md`
9. `docs/TEST_FAULT_MATRIX.md`
10. `docs/ACCEPTANCE_GATES.md`
11. `docs/EVIDENCE_TEMPLATE.md`
12. `docs/REVIEW_CHANGE_PROTOCOL.md`
13. `docs/THIRD_PARTY_BOUNDARY.md`

## Current bounded task

Use `docs/CURRENT_STATUS.md` for the candidate timeline and `docs/VALIDATION_GUIDE.md` for evidence classes. Earlier phase contracts are retained as historical scope documents; they do not authorize restarting old implementation work.

The current operator request covers status/navigation corrections, local verification tooling and fake-only integration evidence on a separate feature branch. It does not authorize a new runtime phase, change of frozen identities, exchange access, deployment or merge. Do not treat implemented Phase 2E candidate code as authorization to begin another phase.

## Absolute restrictions

- Do not copy or import RitMEX source code.
- Do not perform live exchange writes.
- Do not use production trading credentials.
- Do not add exchange authentication/signing or live order methods in this task.
- Do not change the frozen experiment envelope.
- Do not weaken fail-closed requirements.
- Do not modify architecture/contract documents to make implementation easier.
- Do not self-declare independent acceptance or a gate decision.

If a contract is internally inconsistent or cannot be implemented as written, stop with `BLOCKED_CONTRACT_CHANGE_REQUIRED` and describe the exact conflict. Do not silently reinterpret it.

## Completion rule

Commit only the bounded implementation on its own feature branch. Return exact base/result commit and tree identities, changed files, commands, exit codes, counts, and unresolved blockers as requested by the operator and `docs/EVIDENCE_TEMPLATE.md`. Explicitly attest that no real/testnet credentials or exchange writes were used. Stop after evidence delivery; do not begin the next phase.
