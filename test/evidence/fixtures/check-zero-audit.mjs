import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseAuditReport } from "../../../scripts/evidence/phase2d-corrective4-verify-lib.mjs";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const zeroAuditPath = path.join(fixtureDir, "zero-audit.json");
const derived = parseAuditReport(`${readFileSync(zeroAuditPath, "utf8").trim()}\n`);
if (
  derived.facts.auditZero !== true ||
  derived.facts.metadataMatchesRows !== true ||
  derived.facts.vulnerabilityKeys.length !== 0
) {
  process.stderr.write("zero-audit derivation failed\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`AUDIT_ZERO=${String(derived.facts.auditZero)}\n`);
}
