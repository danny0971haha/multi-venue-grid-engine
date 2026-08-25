import path from "node:path";
import process from "node:process";

import { ARTIFACT_DIR_REL, EvidenceError } from "./phase2d-corrective4-schema.mjs";
import { verifyEvidence } from "./phase2d-corrective4-verify-lib.mjs";

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const artifactRoot = path.resolve(process.argv[2] ?? path.join(repositoryRoot, ARTIFACT_DIR_REL));

try {
  const result = verifyEvidence(repositoryRoot, artifactRoot);
  process.stdout.write(
    [
      "phase2d-corrective4 evidence verified independently",
      `schema=${result.schema}`,
      `integrityOk=${String(result.integrityOk)}`,
      `independentReview=${result.independentReview}`,
      `gateStatus=${result.gateStatus}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  const message =
    error instanceof EvidenceError
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
