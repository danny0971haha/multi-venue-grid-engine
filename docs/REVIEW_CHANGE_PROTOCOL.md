# Review and Contract-Change Protocol

Version: `0.1.0`

This repository is designed for work by multiple AI implementation agents under independent review. This document defines which contracts win, how changes are proposed, and what evidence binds a gate decision.

## 1. Roles

### Architect / independent reviewer

Owns:

- product/experiment envelope;
- architecture contracts;
- phase boundaries;
- gate decisions;
- approval/rejection of contract changes;
- live-canary authorization when a future separate contract exists.

### Implementation agent

Owns only the currently authorized bounded implementation phase.

It may:

- implement the current phase;
- add tests/evidence inside allowed scope;
- report contract conflicts;
- propose a contract change.

It may not:

- self-declare a gate PASS;
- silently reinterpret a safety rule;
- edit authoritative contracts merely to make its implementation pass;
- begin the next phase without reviewer PASS.

## 2. Document authority and precedence

For the current baseline, use this precedence:

1. `AGENTS.md` — agent behavior, safety boundary, prohibited actions.
2. `docs/EXPERIMENT_SPEC.md` — frozen numerical experiment envelope and high-level safety thresholds.
3. `docs/RISK_PERSISTENCE_CONTRACT.md` — risk-continuation authority, halt, lease, persistence semantics.
4. `docs/DOMAIN_CONTRACTS.md` — canonical domain identities/data semantics.
5. `docs/VENUE_ADAPTER_CONTRACT.md` — venue protocol normalization/capability semantics.
6. `docs/ARCHITECTURE.md` — component/layer boundaries.
7. `docs/IMPLEMENTATION_CONTRACT.md` — phase ordering and global implementation scope.
8. `docs/PHASE_<N>_CONTRACT.md` — exact allowed work for the currently authorized phase.
9. `docs/TEST_FAULT_MATRIX.md` — minimum verification scenarios.
10. `docs/ACCEPTANCE_GATES.md` — reviewer gate criteria.
11. `docs/EVIDENCE_TEMPLATE.md` — handoff/evidence format.
12. README/convenience documentation.

A lower-precedence document may be more specific, but it cannot weaken a higher-precedence safety or numerical rule.

### 2.1 Conflict behavior

If a material conflict remains after applying precedence:

```text
STOP
STATUS=BLOCKED_CONTRACT_CHANGE_REQUIRED
```

Report:

```text
conflicting files/sections
exact conflicting statements
implementation impact
safest no-change behavior
proposed resolution, if any
```

Do not guess which behavior the user intended.

## 3. Safety-tightening exception

Implementation may always choose a **temporary more restrictive runtime behavior** to fail closed when evidence is missing, for example blocking risk increase on an unclassified venue result.

It may not permanently change the documented public contract under the label of "safer" without review.

Example:

```text
Allowed temporarily:
unknown venue timestamp -> block risk

Not allowed silently:
change daily-loss threshold from 5U to 2U in persisted experiment semantics
```

## 4. Contract-change request

A contract change request must be separate from a phase implementation candidate whenever practical.

Required request:

```text
CHANGE_ID=
REQUESTER=
DATE=
AFFECTED_CONTRACTS=
CURRENT_BEHAVIOR=
PROPOSED_BEHAVIOR=
REASON=
SAFETY_IMPACT=
BACKWARD_COMPATIBILITY=
MIGRATION_REQUIRED=YES|NO
TEST_CHANGES_REQUIRED=
EXPERIMENT_SPEC_VERSION_BUMP=YES|NO
```

A request is not approval.

## 5. Changes requiring experiment-spec version bump

Any change to these frozen v0.1 parameters requires a new experiment spec version before implementation:

```text
starting capital
leverage
margin budget
max planned gross notional
grid level count
grid half-band
daily loss threshold
drawdown threshold
boundary buffer
hard-halt resume semantics that materially change experiment risk
```

Runs from different experiment-spec versions must not be combined as though they were one homogeneous experiment.

## 6. Changes requiring architecture/safety review

Even if numerical values do not change, independent review is required before changing:

- authoritative fill definition;
- `ACK / REJECTED / UNKNOWN / NOT_SENT` semantics;
- order ownership classification;
- treatment of ambiguous writes;
- planned exposure reservation logic;
- exact-pair persistence authority;
- backup-first commit ordering;
- halt-ID acknowledgement authority;
- runtime lease/fencing generation;
- restart continuation gate;
- active reduction versus flatten semantics;
- conditions that return `allowRiskIncrease=true`;
- real venue capability requirements.

## 7. Phase-change protocol

After an implementation agent completes Phase N:

1. stop implementation;
2. commit/push current candidate to its feature branch if authorized by the phase contract;
3. return `docs/EVIDENCE_TEMPLATE.md` packet;
4. reviewer inspects current bytes, diff, tests, CI, and contracts;
5. reviewer returns exactly one gate decision:

```text
PASS
REJECT
BLOCKED
```

Only `PASS` authorizes planning/implementation of Phase N+1.

`PASS` does not authorize live trading, deployment, capital increase, or unrelated work.

## 8. Gate-decision semantics

### PASS

Evidence proves the bounded phase satisfies its contract with no blocking finding.

### REJECT

Current candidate violates the contract or has a correctable implementation defect.

Reviewer should provide bounded corrective instructions tied to the current candidate/base.

### BLOCKED

A required fact/contract/dependency is unavailable or ambiguous, so implementation correctness cannot be established without an external decision/change.

`BLOCKED` is not failure; it prevents guessing.

## 9. Current-byte binding

A review is valid only for the exact bytes/evidence reviewed.

Every gate packet must bind at least:

```text
repository
branch
base SHA
result/current SHA
changed file list
diff stat
patch/PR reference
lockfile hash where relevant
contract/schema/fixture hashes where relevant
```

If code changes after the packet is produced, the previous gate decision does not automatically apply to the new bytes.

## 10. Working-tree candidates

If review occurs before commit, the implementation agent must provide reproducible current-byte evidence:

```text
HEAD SHA
full patch bytes or attached patch
SHA-256 of patch
exact byte/line count where requested
changed-file list
numstat
git diff --check
```

Prose summaries cannot substitute for current bytes.

## 11. Dependency changes

After Gate 0, adding/upgrading/removing a dependency is a reviewed change if it affects production/runtime behavior or safety-critical tests.

Required evidence:

- exact package/version;
- purpose;
- license;
- lockfile diff;
- relevant security/advisory check if available;
- why stdlib/existing dependency is insufficient.

Do not perform unrelated dependency upgrades in a safety corrective patch.

## 12. Venue-contract changes

A venue adapter cannot redefine core semantics to match one exchange.

If a venue cannot satisfy the current adapter contract:

1. mark capability `UNSUPPORTED` or `UNPROVEN`;
2. keep venue ineligible for relevant modes;
3. propose a generic contract extension only if it remains safe for existing venues;
4. do not put venue-specific strategy policy into core abstractions.

## 13. Schema and persisted-state changes

Any breaking persisted-state change requires:

```text
new schema version
migration/compatibility decision
old-state fixture
new-state fixture
corruption/mismatch tests
rollback/recovery discussion
```

Unknown/newer schemas fail closed. Never mutate historical state in place without a reviewed migration.

## 14. Test-change discipline

A corrective change must not:

- delete a failing safety test simply to get green CI;
- weaken an assertion without explaining the contract change;
- replace a real process-crash test with exception-only injection;
- mark mandatory matrix tests skipped and claim PASS;
- modify fixtures to hide a regression without reviewer-visible rationale.

If the test is wrong, fix the contract/test together through review.

## 15. Evidence integrity

Commands must be reported with real exit codes and observed output summaries.

Forbidden evidence behavior:

```text
claiming tests were run when they were not
reporting only successful commands and omitting failures
using stale CI from a different SHA
using generated artifacts from a different commit
claiming a remote branch equals local current bytes without verification
```

## 16. Parallel AI work

Parallel work is allowed only when ownership boundaries do not overlap.

Safe examples after relevant gates:

```text
Agent A: bounded domain implementation
Agent B: independent read-only venue documentation audit
Reviewer: architecture/gate review
```

Unsafe examples:

```text
two agents editing the same safety module independently without a merge contract
frontend agent inventing backend/execution behavior
venue agent changing risk thresholds
multiple agents force-pushing one implementation branch
```

When parallel branches need to converge, choose one explicit integration base and re-run the full affected gate suite after merge/rebase.

## 17. Main branch policy

`main` is the reviewed baseline.

Implementation work occurs on feature branches. Contract updates approved by the architect/reviewer may be committed to `main` as a new baseline before an implementation phase starts.

Do not use force-push to rewrite accepted baseline history.

## 18. Live authorization boundary

No gate in the initial Phase 0–5 implementation contract authorizes live exchange writes.

A future live canary requires a separate, commit-bound authorization contract that states at least:

```text
exact repo/commit
exact venue/market/account scope
capital ceiling
leverage
margin/notional limits
credential permission checks
accepted venue capability audit
accepted dry-run/fault evidence
rollback/kill procedure
explicit human confirmation syntax
```

Until that exists:

```text
LIVE_TRADING_AUTHORIZED=NO
```
