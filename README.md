# Multi-Venue Grid Engine

Independent, from-scratch multi-exchange perpetual-grid trading engine.

## Project status

**Phase 0 toolchain baseline only. No live trading is authorized.**

This repository is intentionally independent. It must not be created as a GitHub fork of another trading bot, and it must not copy unlicensed third-party source code. Public projects may be used for behavioral research and architectural comparison only.

## v0.1 experiment envelope

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
| Live venues in first canary | 1 |

The objective of v0.1 is **execution correctness and operational safety**, not profitability.

## Phase 0 commands

The toolchain is pinned to Node.js `26.5.0` and npm `11.17.0`. Install and verify the current
baseline with:

```bash
npm ci
npm run ci
npm run dry-run
```

`npm run dry-run` is the only runtime entry point in Phase 0. It reports
`liveExchangeWritesEnabled: false`; any configured mode other than `dry-run` fails closed. Phase 0
contains no exchange adapter or exchange write implementation.

## Read first

1. `AGENTS.md` — binding instructions for implementation agents.
2. `docs/ARCHITECTURE.md` — target architecture and domain model.
3. `docs/EXPERIMENT_SPEC.md` — frozen 100U experiment contract.
4. `docs/IMPLEMENTATION_CONTRACT.md` — phased work plan and prohibited changes.
5. `docs/ACCEPTANCE_GATES.md` — PASS / REJECT criteria.
6. `docs/EVIDENCE_TEMPLATE.md` — exact evidence packet required for independent review.
7. `docs/THIRD_PARTY_BOUNDARY.md` — rules for independent reimplementation.

## Non-goals for v0.1

- no adaptive grid shifting;
- no automatic restart after a hard risk halt;
- no multi-venue live capital allocation;
- no live dashboard mutation controls;
- no optimization for short-term PnL;
- no copying third-party trading-bot source code.
