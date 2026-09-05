# Multi-Venue Grid Engine

Independent, from-scratch multi-exchange perpetual-grid trading engine.

## Current status

**Frozen Phase 2D baseline; separate Phase 2E runtime and governance review candidates.** Read [CURRENT_STATUS.md](docs/CURRENT_STATUS.md) for exact identities and review limitations. Live/testnet exchange writes, deployment and merge remain unauthorized.

Agent work starts with [AGENTS.md](AGENTS.md) and the impact-based reading map in [AI_START_HERE.md](AI_START_HERE.md). Complete authorized objectives end to end without treating historical phase instructions as new authorization.

Validation commands and evidence classes: [VALIDATION_GUIDE.md](docs/VALIDATION_GUIDE.md).

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

Start with AGENTS.md and CURRENT_STATUS.md, then use AI_START_HERE.md to select the contracts affected by the task. This map is not a requirement to reread every unrelated historical document for a small documentation change, and it does not change document authority.

| Purpose | Documents |
| --- | --- |
| Behavior, present state and task routing | `AGENTS.md`, `docs/CURRENT_STATUS.md`, `AI_START_HERE.md` |
| Numerical envelope and safety authority | `docs/EXPERIMENT_SPEC.md`, `docs/RISK_PERSISTENCE_CONTRACT.md` |
| Component, domain and venue semantics | `docs/ARCHITECTURE.md`, `docs/DOMAIN_CONTRACTS.md`, `docs/VENUE_ADAPTER_CONTRACT.md` |
| Phase scope and independent gates | `docs/IMPLEMENTATION_CONTRACT.md`, the authorized phase contract, `docs/ACCEPTANCE_GATES.md` |
| Validation and evidence | `docs/VALIDATION_GUIDE.md`, `docs/TEST_FAULT_MATRIX.md`, `docs/EVIDENCE_TEMPLATE.md` |
| Change protocol and third-party boundary | `docs/REVIEW_CHANGE_PROTOCOL.md`, `docs/THIRD_PARTY_BOUNDARY.md` |

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

Read [AI_START_HERE.md](AI_START_HERE.md) and the current status/validation guide. Work only on the explicitly requested bounded task in a separate feature branch. Preserve frozen identities and return evidence for independent review; do not start the next phase automatically.
