# Multi-Venue Grid Engine

Independent, from-scratch multi-exchange perpetual-grid trading engine.

## Current status

**Architecture and implementation-contract baseline only. The next authorized implementation work is Phase 0. Live exchange writes are not authorized.**

This repository is deliberately independent. Third-party projects may be researched for public behavior and architecture, but source code must not be copied unless a compatible license is independently verified and the user separately authorizes the import.

## Frozen v0.1 experiment envelope

| Parameter | Value |
|---|---:|
| Starting capital | 100 USDT |
| Leverage | 5x |
| Maximum margin budget | 30 USDT |
| Maximum planned gross notional | 150 USDT |
| Primary market | BTC perpetual |
| Grid levels | 10 |
| Grid half-band | ±3.0% from anchor |
| Daily loss hard halt | 5 USDT |
| Drawdown-from-start hard halt | 10 USDT |
| Boundary buffer | 1.0% beyond active grid boundary |
| Live venues in first canary | 1 |

The objective of v0.1 is execution correctness, recovery correctness, state integrity, and bounded risk. It is not an optimization exercise for short-term PnL.

## Authoritative document map

Read in this order:

1. `AGENTS.md` — binding agent behavior and safety rules.
2. `docs/EXPERIMENT_SPEC.md` — authoritative numerical experiment envelope.
3. `docs/ARCHITECTURE.md` — component boundaries and system topology.
4. `docs/DOMAIN_CONTRACTS.md` — canonical identities, observations, intents, and state semantics.
5. `docs/VENUE_ADAPTER_CONTRACT.md` — exchange capability and ACK/REJECT/UNKNOWN semantics.
6. `docs/RISK_PERSISTENCE_CONTRACT.md` — fail-closed risk, halt, lease, and durable-state protocol.
7. `docs/IMPLEMENTATION_CONTRACT.md` — phase sequence and phase boundaries.
8. `docs/PHASE_0_CONTRACT.md` — exact first task to hand to an implementation AI.
9. `docs/TEST_FAULT_MATRIX.md` — required test and process-crash matrix.
10. `docs/ACCEPTANCE_GATES.md` — independent PASS / REJECT / BLOCKED gates.
11. `docs/EVIDENCE_TEMPLATE.md` — mandatory checkpoint evidence packet.
12. `docs/REVIEW_CHANGE_PROTOCOL.md` — contract-change and review workflow.
13. `docs/THIRD_PARTY_BOUNDARY.md` — source/research boundary.

If documents appear to conflict, the implementation agent must not guess. Follow the precedence rules in `docs/REVIEW_CHANGE_PROTOCOL.md` and stop with a contract-change request when the conflict is material.

## v0.1 non-goals

- no live exchange writes in the initial implementation contract;
- no adaptive grid shifting;
- no automatic restart after a hard risk halt;
- no simultaneous multi-venue live capital allocation;
- no cross-venue arbitrage strategy in v0.1;
- no live dashboard mutation controls;
- no optimization that weakens safety or reconciliation semantics;
- no copying third-party bot source code.

## Immediate next action

An implementation AI should read `AI_START_HERE.md`, create `experiment/v0.1-phase0`, implement **Phase 0 only**, then stop and return the complete evidence packet for independent review.
