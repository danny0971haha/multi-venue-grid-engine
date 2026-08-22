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
8. `docs/PHASE_0_CONTRACT.md`
9. `docs/TEST_FAULT_MATRIX.md`
10. `docs/ACCEPTANCE_GATES.md`
11. `docs/EVIDENCE_TEMPLATE.md`
12. `docs/REVIEW_CHANGE_PROTOCOL.md`
13. `docs/THIRD_PARTY_BOUNDARY.md`

## Your authorized task

Implement **Phase 0 only** from `docs/PHASE_0_CONTRACT.md`.

Create a feature branch such as:

```bash
git checkout -b experiment/v0.1-phase0
```

Do not implement Phase 1 early, even if Phase 0 is simple.

## Absolute restrictions

- Do not copy or import RitMEX source code.
- Do not perform live exchange writes.
- Do not use production trading credentials.
- Do not add exchange authentication/signing or live order methods in Phase 0.
- Do not change the frozen experiment envelope.
- Do not weaken fail-closed requirements.
- Do not modify architecture/contract documents to make implementation easier.
- Do not self-declare Gate 0 PASS.

If a contract is internally inconsistent or cannot be implemented as written, stop with `BLOCKED_CONTRACT_CHANGE_REQUIRED` and describe the exact conflict. Do not silently reinterpret it.

## Completion rule

When Phase 0 implementation and validation are complete:

1. commit/push only to the Phase 0 feature branch;
2. fill out `docs/EVIDENCE_TEMPLATE.md` in your response;
3. include exact base/result commit SHAs, changed files, diff stat, commands, exit codes, test counts, and unresolved risks;
4. explicitly attest that no live exchange write occurred;
5. stop.

Do not proceed to Phase 1 until an independent reviewer returns `PASS` for Gate 0.
