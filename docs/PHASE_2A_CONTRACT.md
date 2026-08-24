# Phase 2A Implementation Contract — Canonical Durable Envelope and Exact-Pair Inspection

**Status:** AUTHORIZED AFTER INDEPENDENT GATE 1 PASS  
**Date:** 2026-08-23  
**Repository:** `danny0971haha/multi-venue-grid-engine`  
**Implementation branch:** `experiment/v0.1-phase2`  
**Base branch:** `experiment/v0.1-phase1`  
**Accepted Gate 1 HEAD:** `31cfe078c09a15d4906b56fb64731449ca1c598a`  
**Accepted Gate 1 TREE:** `7cbb90ebee0897132df6e0c23b27b1ae33c12e2f`  
**Accepted Corrective 5 implementation:** `76e40fabe470189a2938a953178856ca0310cb3f`  
**Accepted Gate 1 CI:** `32631255732`  
**Parent contracts:** `docs/IMPLEMENTATION_CONTRACT.md`, `docs/RISK_PERSISTENCE_CONTRACT.md`, `docs/TEST_FAULT_MATRIX.md`, `docs/ACCEPTANCE_GATES.md`

## 1. Authorization

Implement **Phase 2A only**: read-side canonical serialization, checksummed `DurableEnvelope<T>`, independent primary/backup inspection, exact-byte-pair authority classification, and deterministic fail-closed reason codes.

```text
INDEPENDENT_REVIEW_GATE_1=PASS
CURRENT_CANDIDATE=PHASE_2A
PHASE_2A=REVIEW_CANDIDATE
PHASE_2B_AUTHORIZED=NO
PHASE_2C_AUTHORIZED=NO
PHASE_2D_AUTHORIZED=NO
PHASE_2E_AUTHORIZED=NO
PHASE_2F_AUTHORIZED=NO
REAL_VENUE_ADAPTER_AUTHORIZED=NO
LIVE_EXCHANGE_WRITE_AUTHORIZED=NO
DEPLOYMENT_AUTHORIZED=NO
MERGE_AUTHORIZED=NO
FORCE_PUSH_AUTHORIZED=NO
```

Phase 1 current bytes are frozen. Do not modify simulator behavior, grid geometry, execution semantics, snapshot semantics, or Phase 1 tests except when adding a non-invasive compatibility fixture is strictly required.

Stop after Phase 2A evidence is produced. Do not begin Phase 2B–2F.

## 2. Explicitly out of scope

Do **not** implement:

- state transition writes;
- temporary file creation;
- backup-first commit;
- rename/fsync protocol;
- real child-process crash matrix;
- automatic initialization;
- automatic repair;
- runtime persistence latch;
- runtime lease/fencing;
- risk calculations;
- `CONTINUE` / `REDUCE` / `HALT` gate;
- halt state machine;
- halt acknowledgement;
- telemetry/manifest;
- venue adapters;
- network access;
- live mode.

Those belong to later checkpoints after a separate review.

An in-memory `buildDurableEnvelope` helper is allowed so tests can construct canonical bytes. It must not write, rename, or delete files.

## 3. Canonical serialization

Project-owned deterministic JSON subset. This implementation does **not** claim RFC 8785 / JCS compliance.

### 3.1 Canonical byte rules

1. UTF-8 only.
2. No BOM.
3. No trailing newline.
4. No insignificant whitespace.
5. Object keys sorted by UTF-16 code-unit lexicographic order (`a < b` on JavaScript strings). This is deterministic and locale-independent.
6. Array order preserved.
7. String content preserved exactly; no locale-dependent or Unicode normalization.
8. Reject `undefined`, function, symbol, bigint, sparse arrays, `Date`, `Buffer`, `Map`, `Set`, class instances, typed arrays, and cyclic objects.
9. Reject `NaN`, `Infinity`, `-Infinity`, and negative zero.
10. Authoritative financial values remain canonical decimal strings. The serializer does not convert decimal strings into JSON numbers.
11. Any accepted JSON number must be a finite IEEE-754 safe integer and is permitted only for schema/metadata fields.
12. Reject unsafe integers and implicit exponent-dependent financial values. An exponent form such as `1e2` may parse as a safe integer, but it is not canonical and is rejected by the stored-byte exact-match rule.
13. Reject dangerous object keys that could affect prototype semantics: `__proto__`, `prototype`, `constructor`.
14. Reject unknown top-level envelope fields for the current schema.
15. Canonicalization must not mutate caller-owned objects.

Own symbol keys and non-plain objects are rejected. Array holes and extra own properties on arrays are rejected.

Own-property descriptors are the authority for this subset. Canonicalization uses `Object.getOwnPropertyDescriptors` and `Reflect.ownKeys` on that descriptor snapshot. `Object.keys()` alone is not a complete own-property set.

For an accepted plain object:

- prototype is `Object.prototype` or `null`;
- no symbol own key;
- every accepted string key is an own data property;
- accessor descriptors (`get` or `set`) are rejected before invocation;
- values are read from `descriptor.value` only;
- non-enumerable string data properties are rejected;
- dangerous keys remain rejected;
- keys remain UTF-16 code-unit sorted;
- canonicalization does not mutate the caller object;
- nested objects use the same rules.

For an accepted array:

- prototype is exactly `Array.prototype`;
- own keys are only `"length"` and canonical indices `"0"` through `String(length-1)`;
- no symbols, extra string properties, non-enumerable extra properties, or holes;
- each element index is an own enumerable data property;
- accessor indices are rejected without calling the getter;
- `length` has the normal array length descriptor (`writable: true`, `enumerable: false`, `configurable: false`, data value);
- hidden metadata is not ignored.

Arbitrary malicious `Proxy` traps are an unverified limitation, not a claimed hostile-object guarantee.

### 3.2 Stored-byte exact match

When reading stored bytes:

1. decode UTF-8 with a fatal decoder;
2. parse the raw JSON;
3. validate the structure;
4. re-canonicalize the parsed full envelope;
5. require raw bytes to equal the canonical bytes exactly.

This rejects:

- duplicate-key JSON after parse/canonical round-trip;
- alternate key order;
- whitespace variants;
- trailing newline;
- BOM;
- semantically equivalent but non-canonical bytes.

## 4. Durable envelope

```ts
type DurableEnvelope<T> = {
  schemaVersion: number;
  kind: string;
  scopeKey: string;
  storeGeneration: string;
  previousEnvelopeSha256: string | null;
  payloadSha256: string;
  payload: T;
  envelopeSha256: string;
};
```

Supported schema version for Phase 2A: `1` only.

Hash algorithm: SHA-256, lowercase hexadecimal, 64 characters.

Required hash construction:

```text
payloadCanonicalBytes =
  canonicalSerialize(payload)
payloadSha256 =
  sha256(payloadCanonicalBytes)
envelopeHashInput =
  canonicalSerialize({
    schemaVersion,
    kind,
    scopeKey,
    storeGeneration,
    previousEnvelopeSha256,
    payloadSha256,
    payload
  })
envelopeSha256 =
  sha256(envelopeHashInput)
fullEnvelopeBytes =
  canonicalSerialize({
    schemaVersion,
    kind,
    scopeKey,
    storeGeneration,
    previousEnvelopeSha256,
    payloadSha256,
    payload,
    envelopeSha256
  })
```

Do not include `envelopeSha256` recursively in its own hash input.

`buildDurableEnvelope` uses Approach A: at entry it explicitly reads each caller-owned field once into locals (`schemaVersion`, `kind`, `scopeKey`, `storeGeneration`, `previousEnvelopeSha256`, `payload`). It does not spread the caller `fields` object and does not observe that object after the snapshot, including for error diagnostics. Documented observation count per accepted input field: 1. Validation uses only the captured metadata. Payload is canonicalized exactly once from the captured payload reference, JSON-parsed into a detached snapshot, and that detached snapshot is the payload used for `payloadSha256`, envelope hash input, the returned envelope, and `fullEnvelopeBytes`. Runtime scalar fields are type-checked before regex tests so values are not accepted by `RegExp` string coercion.

### 4.1 Field validation

- `schemaVersion` must be the supported integer `1`.
- `kind` must be a bounded non-empty string matching `^[A-Za-z][A-Za-z0-9._:-]{0,63}$`.
- `scopeKey` must be a bounded non-empty string matching `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`.
- `storeGeneration` must be a canonical positive base-10 integer string matching `^[1-9][0-9]{0,38}$`.
- Generation is never converted through JavaScript `number`.
- Generation `1` requires `previousEnvelopeSha256 = null`.
- Generation other than `1` requires a lowercase 64-hex previous hash.
- `payloadSha256` must exactly match SHA-256 of the canonical payload bytes.
- `envelopeSha256` must exactly match SHA-256 of the canonical envelope hash input.
- raw stored bytes must exactly equal `fullEnvelopeBytes`.
- no extra top-level keys.
- malformed or unsupported values are fail-closed.

## 5. Exact-pair inspection

Inspect independently:

```text
<state>.json
<state>.json.bak
```

Backup path is the primary path plus the suffix `.bak`.

Each copy is read and validated independently. Both copies are inspected even when the first is invalid.

```ts
type CopyInspection =
  | { status: "MISSING" }
  | { status: "VALID"; rawSha256: string; envelope: DurableEnvelope<unknown> }
  | { status: "INVALID"; reasonCodes: string[] }
  | { status: "IO_FAILURE"; reasonCodes: string[] };

type PairInspection = {
  pairStatus: "EXACT_PAIR" | "BOTH_ABSENT" | "UNPROVEN";
  primary: CopyInspection;
  backup: CopyInspection;
  exactBytesEqual: boolean;
  pairAuthorityProven: boolean;
  lineageStatus: "PROVEN" | "UNVERIFIED" | "MISMATCH";
  generation: string | null;
  envelopeSha256: string | null;
  reasonCodes: string[];
  allowRiskIncrease: false;
};
```

Mandatory rules:

1. Both copies must be inspected even when the first is invalid.
2. One valid copy is never sufficient.
3. Two individually valid but byte-different copies are never sufficient.
4. Semantically equivalent but byte-different copies are not an exact pair.
5. Never auto-select the higher generation.
6. Never rewrite or repair either file.
7. Never delete or rename temp files.
8. Never manufacture a clean lineage.
9. Wrong kind, scope, or schema is unproven.
10. Unsupported or legacy schema is unproven.
11. Both missing is an explicit uninitialized/absent disposition, not authority.
12. A leftover sibling `*.tmp` file is non-authoritative and must not alter evaluation of an otherwise exact old pair.
13. Inspection errors must not include payload bytes or secrets.
14. Reason-code ordering must be deterministic.
15. File bytes and mtimes must remain unchanged after inspection.

Phase 2A always returns `allowRiskIncrease=false`, even for an exact pair, because runtime latch, lease, risk gates, and restart reconciliation do not exist yet.

`pairAuthorityProven=true` is storage evidence only. It is not a continuation authorization.

`exactBytesEqual` is true only when both files exist and their raw bytes are identical.

`generation` and `envelopeSha256` are populated only when both copies are independently `VALID` and raw bytes are identical. Otherwise they are `null`.

Expected kind / scope, when supplied, are pair-level constraints. A structurally valid copy remains `VALID`; a mismatch yields `WRONG_KIND` / `WRONG_SCOPE` and `pairAuthorityProven=false`.

Unsupported schema is a copy-level validation failure (`UNSUPPORTED_SCHEMA`).

## 6. Lineage handling

Phase 2A does **not** persist a historical envelope archive and does **not** invent a recovery protocol.

`docs/RISK_PERSISTENCE_CONTRACT.md` section 14 requires a valid generation/hash chain for exact-pair authority. A complete restart-time cryptographic proof of every historical predecessor would require a persisted archive that Phase 2A is not authorized to create.

Phase 2A therefore uses this bounded interpretation rather than stopping as `BLOCKED_CONTRACT_CLARIFICATION_REQUIRED`:

- Structural lineage is always checked: generation `1` requires `previousEnvelopeSha256=null`; any other canonical generation requires a lowercase 64-hex previous hash.
- Inspection may accept an optional expected predecessor anchor: `expectedGeneration` and/or `expectedPreviousEnvelopeSha256`.
- When an expected anchor is supplied, the observed pair must match the supplied field(s) exactly. Mismatch yields `lineageStatus=MISMATCH` and `pairAuthorityProven=false`.
- When no historical anchor is supplied:
  - generation `1` with `previousEnvelopeSha256=null` reports `lineageStatus=PROVEN` for the initial structural rule;
  - generation greater than `1` reports `lineageStatus=UNVERIFIED`;
  - the implementation does not claim that complete historical lineage was cryptographically proven.

This is storage-pair evidence only. Phase 2B+ write protocol and later restart reconciliation remain unauthorized.

## 7. Reason codes

Stable machine-readable codes. Inspection returns a disposition object, not a boolean or generic `Error` as the only signal.

Bound names:

```text
EXACT_PAIR_PROVEN
BOTH_ABSENT
PRIMARY_MISSING
BACKUP_MISSING
PRIMARY_INVALID
BACKUP_INVALID
PAIR_BYTES_MISMATCH
PAIR_GENERATION_MISMATCH
PAIR_ENVELOPE_HASH_MISMATCH
PAYLOAD_HASH_MISMATCH
ENVELOPE_HASH_MISMATCH
NON_CANONICAL_BYTES
UNSUPPORTED_SCHEMA
WRONG_KIND
WRONG_SCOPE
INVALID_GENERATION
INVALID_PREVIOUS_HASH
LINEAGE_MISMATCH
PRIMARY_IO_FAILURE
BACKUP_IO_FAILURE
MALFORMED_JSON
UNKNOWN_TOP_LEVEL_FIELD
INVALID_KIND
INVALID_SCOPE
CANONICALIZATION_REJECTED
DANGEROUS_OBJECT_KEY
TEMP_FILE_NON_AUTHORITATIVE
```

`TEMP_FILE_NON_AUTHORITATIVE` may appear when a leftover `*.tmp` sibling exists. It must not by itself clear `pairAuthorityProven` for an otherwise exact pair.

Reason codes are sorted by the documented catalog order. Unknown codes, if any, sort after the catalog in UTF-16 code-unit order.

Inspection error messages and thrown diagnostics must not include payload bytes or fixture secret-like strings.

## 8. Required tests

Deterministic, network-free tests using fresh temporary directories.

Durable-pair cases:

| ID | Disk state | Required result |
|---|---|---|
| P2-D01 | valid identical canonical pair | `pairAuthorityProven=true`; `allowRiskIncrease=false` |
| P2-D02 | primary missing / backup valid | unproven |
| P2-D03 | backup missing / primary valid | unproven |
| P2-D04 | primary corrupt / backup valid | unproven |
| P2-D05 | backup corrupt / primary valid | unproven |
| P2-D06 | both corrupt | unproven |
| P2-D07 | both valid but bytes or generation differ | unproven |
| P2-D08 | backup one generation ahead | unproven; no newer-copy selection |
| P2-D09 | primary one generation ahead | unproven |
| P2-D10 | unexpected generation | unproven |
| P2-D11 | previous hash / expected lineage mismatch | unproven |
| P2-D12 | wrong scope or kind | unproven |
| P2-D13 | legacy / unknown schema | unproven |
| P2-D14 | temp file beside valid exact old pair | temp non-authoritative; old exact pair inspectable normally |

Canonicalization cases:

```text
2A-C01 different input object key order -> identical canonical bytes/hash
2A-C02 payload byte mutation -> payload hash failure
2A-C03 recomputed payload hash but stale envelope hash -> envelope failure
2A-C04 duplicate raw JSON keys -> rejected as non-canonical
2A-C05 whitespace variant -> rejected
2A-C06 trailing newline -> rejected
2A-C07 UTF-8 BOM -> rejected
2A-C08 unknown top-level field -> rejected
2A-C09 unsafe integer -> rejected
2A-C10 negative zero -> rejected
2A-C11 dangerous prototype key -> rejected
2A-C12 sparse array / non-plain object -> serializer rejection
2A-C13 generation 1 with non-null previous hash -> rejected
2A-C14 generation >1 with null/invalid previous hash -> rejected
2A-C15 semantically equal but byte-different pair -> unproven
2A-C16 inspection performs zero writes and preserves bytes/mtimes
2A-C17 deterministic reason-code ordering
2A-C18 payload/error diagnostics do not leak fixture secret-like strings
2A-C19 existing Phase 1 tests remain green
2A-C20 dry-run remains liveExchangeWrites=false
```

Do not implement the real SIGKILL atomic-write matrix. That belongs to Phase 2B.

Stable fixture vectors must contain and be asserted literally:

```text
CANONICAL_PAYLOAD_BYTES
PAYLOAD_SHA256
CANONICAL_ENVELOPE_HASH_INPUT_BYTES
ENVELOPE_SHA256
FULL_ENVELOPE_BYTES
```

Later implementations must not silently change serialization.

## 9. Allowed paths

Production:

```text
src/persistence/canonical-json.ts
src/persistence/durable-envelope.ts
src/persistence/exact-pair-inspection.ts
src/persistence/index.ts
```

`src/persistence/index.ts` may only re-export the bounded Phase 2A surface.

Tests:

```text
test/persistence/**
test/fixtures/**   # Phase 2A fixtures only
```

Documentation:

```text
docs/PHASE_2A_CONTRACT.md
docs/PHASE_2A_EVIDENCE.md
docs/IMPLEMENTATION_CONTRACT.md   # narrowly additive status/reference only
docs/ACCEPTANCE_GATES.md          # narrowly additive status/reference only
```

`package.json` may register an existing-style focused test script. No new dependency is authorized. Use Node built-ins such as `node:crypto` and `node:fs`.

## 10. Prohibited actions

If a prohibited path is required, stop and report `BLOCKED_SCOPE_CHANGE_REQUIRED`.

Phase 1 files, venue adapters, network/authentication, runtime lease, risk engine, halt/ACK, telemetry, deployment, CI redesign, dependency upgrades, unrelated formatting/refactors, and live-mode behavior are prohibited.

## 11. Reviewer decision

The implementation agent must not declare `PHASE_2A=PASS` or `GATE_2=PASS`. The independent reviewer owns `PASS` / `REJECT` / `BLOCKED`.
