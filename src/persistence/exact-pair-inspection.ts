import { Buffer } from "node:buffer";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { DurableEnvelope } from "./durable-envelope.js";
import {
  parseAndValidateDurableEnvelope,
  sha256HexBytes,
} from "./durable-envelope.js";

export const REASON_CODE_CATALOG = [
  "EXACT_PAIR_PROVEN",
  "BOTH_ABSENT",
  "PRIMARY_MISSING",
  "BACKUP_MISSING",
  "PRIMARY_INVALID",
  "BACKUP_INVALID",
  "PAIR_BYTES_MISMATCH",
  "PAIR_GENERATION_MISMATCH",
  "PAIR_ENVELOPE_HASH_MISMATCH",
  "PAYLOAD_HASH_MISMATCH",
  "ENVELOPE_HASH_MISMATCH",
  "NON_CANONICAL_BYTES",
  "UNSUPPORTED_SCHEMA",
  "WRONG_KIND",
  "WRONG_SCOPE",
  "INVALID_GENERATION",
  "INVALID_PREVIOUS_HASH",
  "LINEAGE_MISMATCH",
  "PRIMARY_IO_FAILURE",
  "BACKUP_IO_FAILURE",
  "MALFORMED_JSON",
  "UNKNOWN_TOP_LEVEL_FIELD",
  "INVALID_KIND",
  "INVALID_SCOPE",
  "CANONICALIZATION_REJECTED",
  "DANGEROUS_OBJECT_KEY",
  "TEMP_FILE_NON_AUTHORITATIVE",
] as const;

export type PersistenceReasonCode = (typeof REASON_CODE_CATALOG)[number];

export type CopyInspection =
  | { status: "MISSING" }
  | { status: "VALID"; rawSha256: string; envelope: DurableEnvelope<unknown> }
  | { status: "INVALID"; reasonCodes: string[] }
  | { status: "IO_FAILURE"; reasonCodes: string[] };

export type PairInspection = {
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

export type ExactPairInspectRequest = {
  directory: string;
  stateName: string;
  expectedKind: string;
  expectedScopeKey: string;
  expectedGeneration?: string;
  expectedPreviousEnvelopeSha256?: string | null;
};

type InternalCopy = CopyInspection & { rawBytes?: Buffer };

export function sortReasonCodes(codes: readonly string[]): string[] {
  const unique = [...new Set(codes)];
  const rank = new Map<string, number>(REASON_CODE_CATALOG.map((code, index) => [code, index]));
  return unique.sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank === undefined && rightRank === undefined) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    if (leftRank === undefined) {
      return 1;
    }
    if (rightRank === undefined) {
      return -1;
    }
    return leftRank - rightRank;
  });
}

export async function inspectExactPair(
  request: ExactPairInspectRequest,
): Promise<PairInspection> {
  const primaryPath = path.join(request.directory, `${request.stateName}.json`);
  const backupPath = path.join(request.directory, `${request.stateName}.json.bak`);
  const primary = await inspectCopy(primaryPath, "PRIMARY");
  const backup = await inspectCopy(backupPath, "BACKUP");
  const reasonCodes: string[] = [];

  if (primary.status === "MISSING" && backup.status === "MISSING") {
    reasonCodes.push("BOTH_ABSENT");
    reasonCodes.push(...(await leftoverTempCodes(request)));
    return finalizePair({
      pairStatus: "BOTH_ABSENT",
      primary: toPublicCopy(primary),
      backup: toPublicCopy(backup),
      exactBytesEqual: false,
      pairAuthorityProven: false,
      lineageStatus: "UNVERIFIED",
      generation: null,
      envelopeSha256: null,
      reasonCodes,
    });
  }

  if (primary.status === "MISSING") {
    reasonCodes.push("PRIMARY_MISSING");
  }
  if (backup.status === "MISSING") {
    reasonCodes.push("BACKUP_MISSING");
  }
  if (primary.status === "INVALID") {
    reasonCodes.push("PRIMARY_INVALID", ...primary.reasonCodes);
  }
  if (backup.status === "INVALID") {
    reasonCodes.push("BACKUP_INVALID", ...backup.reasonCodes);
  }
  if (primary.status === "IO_FAILURE") {
    reasonCodes.push("PRIMARY_IO_FAILURE", ...primary.reasonCodes);
  }
  if (backup.status === "IO_FAILURE") {
    reasonCodes.push("BACKUP_IO_FAILURE", ...backup.reasonCodes);
  }

  const exactBytesEqual =
    primary.rawBytes !== undefined &&
    backup.rawBytes !== undefined &&
    primary.rawBytes.equals(backup.rawBytes);

  let generation: string | null = null;
  let envelopeSha256: string | null = null;
  let lineageStatus: PairInspection["lineageStatus"] = "UNVERIFIED";
  let pairAuthorityProven = false;

  if (primary.status === "VALID" && backup.status === "VALID") {
    if (!exactBytesEqual) {
      reasonCodes.push("PAIR_BYTES_MISMATCH");
      if (primary.envelope.storeGeneration !== backup.envelope.storeGeneration) {
        reasonCodes.push("PAIR_GENERATION_MISMATCH");
      }
      if (primary.envelope.envelopeSha256 !== backup.envelope.envelopeSha256) {
        reasonCodes.push("PAIR_ENVELOPE_HASH_MISMATCH");
      }
    } else {
      generation = primary.envelope.storeGeneration;
      envelopeSha256 = primary.envelope.envelopeSha256;

      if (primary.envelope.kind !== request.expectedKind) {
        reasonCodes.push("WRONG_KIND");
      }
      if (primary.envelope.scopeKey !== request.expectedScopeKey) {
        reasonCodes.push("WRONG_SCOPE");
      }

      const lineage = classifyLineage(primary.envelope, request);
      lineageStatus = lineage.status;
      if (lineage.status === "MISMATCH") {
        reasonCodes.push("LINEAGE_MISMATCH");
      }

      pairAuthorityProven =
        primary.envelope.kind === request.expectedKind &&
        primary.envelope.scopeKey === request.expectedScopeKey &&
        lineage.status !== "MISMATCH";
      if (pairAuthorityProven) {
        reasonCodes.push("EXACT_PAIR_PROVEN");
      }
    }
  }

  reasonCodes.push(...(await leftoverTempCodes(request)));

  return finalizePair({
    pairStatus: pairAuthorityProven ? "EXACT_PAIR" : "UNPROVEN",
    primary: toPublicCopy(primary),
    backup: toPublicCopy(backup),
    exactBytesEqual,
    pairAuthorityProven,
    lineageStatus,
    generation,
    envelopeSha256,
    reasonCodes,
  });
}

export function formatPairInspectionDiagnostic(inspection: PairInspection): string {
  return JSON.stringify({
    pairStatus: inspection.pairStatus,
    pairAuthorityProven: inspection.pairAuthorityProven,
    allowRiskIncrease: inspection.allowRiskIncrease,
    exactBytesEqual: inspection.exactBytesEqual,
    lineageStatus: inspection.lineageStatus,
    generation: inspection.generation,
    envelopeSha256: inspection.envelopeSha256,
    reasonCodes: inspection.reasonCodes,
    primary: formatCopyDiagnostic(inspection.primary),
    backup: formatCopyDiagnostic(inspection.backup),
  });
}

function formatCopyDiagnostic(
  copy: CopyInspection,
): { status: string; rawSha256?: string; envelopeSha256?: string; reasonCodes?: string[] } {
  if (copy.status === "VALID") {
    return {
      status: copy.status,
      rawSha256: copy.rawSha256,
      envelopeSha256: copy.envelope.envelopeSha256,
    };
  }
  if (copy.status === "MISSING") {
    return { status: copy.status };
  }
  return { status: copy.status, reasonCodes: copy.reasonCodes };
}

async function inspectCopy(filePath: string, side: "PRIMARY" | "BACKUP"): Promise<InternalCopy> {
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(filePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { status: "MISSING" };
    }
    return { status: "IO_FAILURE", reasonCodes: [`${side}_IO_FAILURE`] };
  }

  const parsed = parseAndValidateDurableEnvelope(rawBytes);
  if (!parsed.ok) {
    return { status: "INVALID", reasonCodes: parsed.reasonCodes, rawBytes };
  }
  return {
    status: "VALID",
    rawSha256: sha256HexBytes(rawBytes),
    envelope: parsed.envelope,
    rawBytes,
  };
}

function toPublicCopy(copy: InternalCopy): CopyInspection {
  if (copy.status === "VALID") {
    return {
      status: "VALID",
      rawSha256: copy.rawSha256,
      envelope: copy.envelope,
    };
  }
  if (copy.status === "INVALID") {
    return { status: "INVALID", reasonCodes: copy.reasonCodes };
  }
  if (copy.status === "IO_FAILURE") {
    return { status: "IO_FAILURE", reasonCodes: copy.reasonCodes };
  }
  return { status: "MISSING" };
}

function classifyLineage(
  envelope: DurableEnvelope<unknown>,
  request: ExactPairInspectRequest,
): { status: PairInspection["lineageStatus"] } {
  if (
    "expectedGeneration" in request &&
    request.expectedGeneration !== envelope.storeGeneration
  ) {
    return { status: "MISMATCH" };
  }
  if (
    "expectedPreviousEnvelopeSha256" in request &&
    request.expectedPreviousEnvelopeSha256 !== envelope.previousEnvelopeSha256
  ) {
    return { status: "MISMATCH" };
  }
  if (envelope.storeGeneration === "1" && envelope.previousEnvelopeSha256 === null) {
    return { status: "PROVEN" };
  }
  if (
    "expectedPreviousEnvelopeSha256" in request &&
    request.expectedPreviousEnvelopeSha256 === envelope.previousEnvelopeSha256
  ) {
    return { status: "PROVEN" };
  }
  return { status: "UNVERIFIED" };
}

async function leftoverTempCodes(request: ExactPairInspectRequest): Promise<string[]> {
  try {
    const names = await readdir(request.directory);
    const hasTemp = names.some(
      (name) => name.startsWith(`${request.stateName}.json`) && name.endsWith(".tmp"),
    );
    return hasTemp ? ["TEMP_FILE_NON_AUTHORITATIVE"] : [];
  } catch {
    return [];
  }
}

function finalizePair(
  inspection: Omit<PairInspection, "allowRiskIncrease" | "reasonCodes"> & {
    reasonCodes: string[];
  },
): PairInspection {
  return {
    ...inspection,
    allowRiskIncrease: false,
    reasonCodes: sortReasonCodes(inspection.reasonCodes),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
