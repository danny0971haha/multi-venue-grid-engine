import process from "node:process";

import {
  EvidenceError,
  generateEvidence,
  repositoryRootFromImportMeta,
} from "./phase2d-corrective4-lib.mjs";

const repositoryRoot = repositoryRootFromImportMeta(import.meta.url);

try {
  const manifest = generateEvidence(repositoryRoot);
  process.stdout.write(
    [
      "phase2d-corrective4 evidence generated",
      `schema=${manifest.schema}`,
      `sourceHeadSha=${manifest.identity.sourceHeadSha}`,
      `testedCheckoutSha=${manifest.identity.testedCheckoutSha}`,
      `fullTests=${manifest.testFacts.full.total}`,
      `corrective4Tests=${manifest.testFacts.corrective4.total}`,
      "gateStatus=NOT_EMITTED",
      "",
    ].join("\n"),
  );
} catch (error) {
  const message =
    error instanceof EvidenceError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
