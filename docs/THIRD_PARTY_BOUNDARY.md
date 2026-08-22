# Third-Party Research and Source Boundary

## Why this repository is independent

The project is deliberately created as an original repository rather than a GitHub fork. This prevents repository-network dependency and keeps ownership/history under the user's account.

Independence does **not** by itself grant permission to copy third-party source code.

## Current RitMEX research baseline

Reference repository:

- `discountry/ritmex-bot`
- observed baseline commit: `0a757985b87cd9e0733800da8bb584820ed749de`
- observed date: 2026-08-20

At research time, GitHub repository metadata reported no detected license and a root `LICENSE` file was not found. Therefore:

- do not vendor or copy its source into this project;
- do not transplant its tests, comments, fixtures, or implementation patches;
- do not present this project as a modified RitMEX distribution.

## What may be learned from external systems

General engineering concepts may be independently implemented, including:

- per-grid-level state machines;
- order ownership registries;
- restart reconciliation;
- exchange-side stop concepts;
- position coverage audits;
- capability-based venue adapters;
- adaptive grid ideas in future spec versions.

These concepts must be expressed through original code and this project's own contracts/tests.

## Preferred external sources for implementation details

Use official exchange/API documentation and original protocol specifications for concrete wire behavior.
