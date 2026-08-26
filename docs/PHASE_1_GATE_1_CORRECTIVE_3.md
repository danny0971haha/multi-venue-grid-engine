# Phase 1 Gate 1 Corrective 3

**Status:** AUTHORITATIVE BOUNDED CORRECTIVE / GATE 1 REVIEW CANDIDATE  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase1`  
**Draft PR:** `#2`  
**Corrective base SHA:** `77df41a657d62157f5a373bc3f83c72ae39c565d`  
**Parent corrective:** `docs/PHASE_1_GATE_1_CORRECTIVE_2.md`

This document describes the Corrective 3 candidate. It does not declare `GATE_1=PASS`. The independent reviewer owns that verdict.

## 1. Corrective base

```text
CORRECTIVE_BASE_SHA=77df41a657d62157f5a373bc3f83c72ae39c565d
AUTHORIZED_WORK=PHASE_1_GATE_1_CORRECTIVE_3_ONLY
PHASE_2_AUTHORIZED=NO
```

## 2. Root cause

Corrective 2 stopped imported `ownership="OWNED"` from self-attesting through `knownExchangeOrderIds`. Current bytes still treated two weaker facts as cancel authority:

1. `classifyOwnership()` returned `OWNED` when `observed.clientOrderId` existed in `knownClientOrderIds`. That set was seeded from every current-scope intent, including planned-only, `NOT_SENT`, and `REJECTED` intents.
2. `hasProvenAuthorityLinkage()` only checked structural equality between an order and an intent. A cloned or imported order could reuse a real intent's `intentId` / `clientOrderId` / level / purpose / side / quantity without an ACK or authoritative observation.

Those paths allowed a forged current-scope order that merely reused a real client order ID to be classified `OWNED`, enter duplicate cleanup, and receive `requestCancel()` ACK.

## 3. Authority data model

Authority is a separate, serializable ledger. It is not derived from `order.ownership`, `order.clientOrderId`, or structural equality.

```ts
type OrderAuthoritySource = "ACK" | "AUTHORITATIVE_OBSERVATION";

type OrderAuthorityLink = {
  source: OrderAuthoritySource;
  evidenceId: string;
  exchangeOrderId: ExchangeOrderId;
  intentId: IntentId;
  clientOrderId: ClientOrderId;
  scopeKey: ScopeKey;
  anchorEpoch: AnchorEpoch;
};
```

Runtime storage: `DeterministicSimulator` keeps `authorityLinks` keyed by `exchangeOrderId`. Snapshot field: `authorityLinks: OrderAuthorityLink[]`, sorted by `exchangeOrderId` then `evidenceId`.

`knownClientOrderIds` remains only for stale/wrong-epoch detection. `knownExchangeOrderIds` is now the set of authority-linked exchange IDs and does not itself grant `OWNED`.

## 4. ACK authority creation

`submit(intent, "ACK")` is the only placement path that records:

```text
source=ACK
evidenceId=ack:<exchangeOrderId>
```

The link copies the ACK'd intent's `intentId`, `clientOrderId`, `scopeKey`, and `anchorEpoch`.

## 5. AUTHORITATIVE_OBSERVATION authority creation

`discoverOwnedOrder(intentId)` records:

```text
source=AUTHORITATIVE_OBSERVATION
evidenceId=obs:<exchangeOrderId>
```

only after a prior `UNKNOWN` write exists for that intent. `UNKNOWN` itself never creates authority.

`injectOwnedDuplicate()` is a simulator duplicate-discovery seam used by `P1-I06`. It records `AUTHORITATIVE_OBSERVATION` only when a current-scope source intent with a client order ID already exists. It does not bootstrap authority from a client ID alone.

## 6. NOT_SENT / REJECTED / UNKNOWN semantics

| Path | Creates order | Creates authority | Later observed order using that client ID |
| --- | --- | --- | --- |
| `planEntries()` only | No | No | `AMBIGUOUS` |
| `submit(..., "NOT_SENT")` | No | No | `AMBIGUOUS` |
| `submit(..., "REJECTED")` | No | No | `AMBIGUOUS` |
| `submit(..., "UNKNOWN")` before discovery | No | No | `AMBIGUOUS` |
| `submit(..., "ACK")` | Yes | `ACK` | `OWNED` after full linkage |
| `UNKNOWN` then `discoverOwnedOrder()` | Yes | `AUTHORITATIVE_OBSERVATION` | `OWNED` after full linkage |
| `injectForeignOrder()` / `injectAmbiguousOrder()` | Yes | No | never `OWNED` from that injection |
| Imported `ownership="OWNED"` | Import only | No, unless a valid ledger row exists | `AMBIGUOUS` or import reject |

## 7. Ownership classification table

| Condition | Classification |
| --- | --- |
| Observed scope or epoch positively belongs to another strategy instance | `UNOWNED` |
| Client ID recorded against a different epoch | `UNOWNED` |
| Proven authority link exists for this `exchangeOrderId`, source is `ACK` or `AUTHORITATIVE_OBSERVATION`, evidence ID is non-empty and unique, and authority/order/intent IDs plus scope, epoch, level, purpose, side, and quantity all match | `OWNED` |
| Current-scope or incomplete identity without proven authority | `AMBIGUOUS` |

`OWNED` is never granted by:

```text
known current clientOrderId alone
structural equality alone
serialized order.ownership == "OWNED" alone
knownExchangeOrderIds membership alone
```

Unproven current-scope orders stay `AMBIGUOUS`. They are not downgraded to `UNOWNED` to clear a risk blocker.

## 8. Snapshot schema / migration decision

```text
schemaVersion: phase1-simulator-1 -> phase1-simulator-2
```

Required new field: `authorityLinks`.

Decision: bump the Phase 1 simulator schema. A `phase1-simulator-1` snapshot is rejected with `SnapshotImportError`. Old schema bytes are not treated as having proven authority, and ownership/client IDs are not migrated into `OWNED`.

Serialized `order.ownership` remains a derived/display field. Import ignores it and reclassifies from the validated ledger.

## 9. Snapshot authority validation

Import throws `SnapshotImportError` when any of the following is true:

```text
authority evidenceId empty or duplicated
authority exchangeOrderId does not name an imported order
authority intentId does not name an imported intent
authority clientOrderId does not match both order and intent
scopeKey or anchorEpoch mismatch against order, intent, or snapshot init
order structural fields do not match the linked intent
two authority rows name the same exchangeOrderId
an order with intentId=null has an authority row
dangling authority of any kind
```

Inconsistent authority is never silently repaired into `OWNED`.

## 10. Cancel authority contract

`planDuplicateCleanup()`, `planDuplicateCleanupByPrice()`, and `requestCancel()` accept only proven `OWNED`.

An unlinked, forged, structurally cloned, or client-ID-only order:

```text
is absent from cancelExchangeOrderIds
requestCancel() returns NOT_SENT
reason is REFUSES_UNPROVEN_CANCEL_AUTHORITY when classification is not UNOWNED
does not change order status, presence, or level state
never produces an ACK cancel
```

Clearly foreign orders still return `REFUSES_UNOWNED_CANCEL`.

## 11. Risk blocker contract

Any current-scope, present-in-open-book order that lacks proven authority is `AMBIGUOUS` and keeps `canIncreaseRisk()=false`. Serialized `riskIncreaseBlocked=false` cannot override that derived blocker. `planEntries()` must not create new risk-increasing writes while the blocker is active.

## 12. Test matrix

```text
C3-1 real current clientOrderId cannot self-bootstrap ownership
C3-2 structural clone without authority is not OWNED
C3-3 planned, NOT_SENT and REJECTED intents grant no authority
C3-4 ACK-linked order remains OWNED after restart
C3-5 authoritative discovery remains OWNED after restart
C3-6 forged order cannot enter duplicate cleanup
C3-7 forged order cannot pass requestCancel
C3-8 serialized ownership continues to be ignored
C3-9 malformed authority fails closed
C3-10 ambiguous order remains a risk blocker after restart
```

Existing `P1-*`, `C1-C13`, and `D1-D13` cases remain required.

## 13. Verification commands

Use Node 22.23.2 and npm 10.9.8:

```bash
node --version
npm --version
npm ci
git diff --check
npm run format:check
npm run lint
npm run typecheck
npm run test:phase1
npm test
npm run scan:secrets
npm run build
npm run check
npm run dry-run
```

Static checks:

```bash
git grep -n "knownClientOrderIds" -- src test
git grep -n "classifyOwnership" -- src test
git grep -n "hasProvenAuthorityLinkage" -- src test
git grep -n "ownership.*OWNED" -- src/simulator test/simulator
git grep -n "requestCancel\\|planDuplicateCleanup" -- src/simulator test/simulator
```

## 14. Stop before Phase 2

```text
PHASE_2_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
```

This corrective stops after a Phase 1 review candidate is produced. Independent review decides `GATE_1`.
