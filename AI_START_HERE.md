# AI START HERE

Use this entrypoint for the current bounded task, not as a standing instruction to restart an earlier phase. [AGENTS.md](AGENTS.md) defines behavior and safety; this file is a reading map, not a second authorization source.

## Start every task here

1. Read [AGENTS.md](AGENTS.md) and [CURRENT_STATUS.md](docs/CURRENT_STATUS.md).
2. Read [REVIEW_CHANGE_PROTOCOL.md](docs/REVIEW_CHANGE_PROTOCOL.md) for authority, material conflicts, phase gates and evidence integrity.
3. Identify the operator's current objective, analysis-only versus implementation mode, allowed paths and required checks. Record actual branch, HEAD/tree, working-tree status and relevant candidate refs before changes.

A status snapshot is not proof that remote refs still match it. Check expected identities through permitted reads; an offline workflow must not enable networking to do so. State which refs could not be checked. Missing scope does not authorize a new phase.

## Read according to impact

| Task impact | Additional required reading |
| --- | --- |
| Documentation, navigation or formatting only | Affected documents, their incoming/outgoing references and any contract statement being described. |
| Validation tooling, fixtures or tests | [VALIDATION_GUIDE.md](docs/VALIDATION_GUIDE.md), the affected test contract, [TEST_FAULT_MATRIX.md](docs/TEST_FAULT_MATRIX.md) and [EVIDENCE_TEMPLATE.md](docs/EVIDENCE_TEMPLATE.md). |
| Runtime, risk, persistence, halt/ACK or execution | [EXPERIMENT_SPEC.md](docs/EXPERIMENT_SPEC.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [DOMAIN_CONTRACTS.md](docs/DOMAIN_CONTRACTS.md), [RISK_PERSISTENCE_CONTRACT.md](docs/RISK_PERSISTENCE_CONTRACT.md), relevant phase contracts and fault matrices; also [VENUE_ADAPTER_CONTRACT.md](docs/VENUE_ADAPTER_CONTRACT.md) when venue semantics are involved. |
| Phase implementation or formal gate handoff | [IMPLEMENTATION_CONTRACT.md](docs/IMPLEMENTATION_CONTRACT.md), the explicitly authorized phase/checkpoint contract, [ACCEPTANCE_GATES.md](docs/ACCEPTANCE_GATES.md) and [EVIDENCE_TEMPLATE.md](docs/EVIDENCE_TEMPLATE.md). |
| External concepts, venue research or dependencies | [THIRD_PARTY_BOUNDARY.md](docs/THIRD_PARTY_BOUNDARY.md), relevant venue/dependency contracts and verified primary sources for facts used. |

Read the applicable material fully enough to establish the affected semantics. Explicit task/gate reading requirements remain mandatory. If impact is uncertain, expand read-only investigation before editing. Convenience reading order does not override the protocol's precedence or any safety contract.

## Execution and stopping

For an authorized implementation, complete the objective end to end under the autonomy rules in AGENTS.md. Resolve ordinary in-scope implementation failures without requesting another prompt. Keep required validation commands, pinned dependencies, historical test identities and fail-closed behavior intact.

On a material unresolved contract conflict, stop disputed implementation with `BLOCKED_CONTRACT_CHANGE_REQUIRED`. Give the exact files/statements, impact, safest no-change behavior and proposed resolution; do not silently reinterpret the contract or modify your rules to get unstuck.

For the candidate status recorded in CURRENT_STATUS, real/testnet credentials, exchange networking, a new runtime phase, automatic governance rebind, deployment and merge remain unauthorized. Historical requests and implemented candidate code do not grant those permissions.

## Completion

Perform final diff/counterexample self-review and return the required evidence packet with exact identities, scope, real command exits, counts, hashes and unresolved blockers. State what was not run and whether credentials or exchange writes were used. Commit/push only where authorized, on the task's feature branch. Stop after handoff; self-review is not independent acceptance and does not start the next phase.
