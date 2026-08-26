import path from "node:path";
import process from "node:process";

import {
  EvidenceError,
  repositoryRootFromImportMeta,
  writeSyntheticArtifact,
} from "./phase2d-corrective4-lib.mjs";

const repositoryRoot = repositoryRootFromImportMeta(import.meta.url);
const artifactRoot = path.resolve(process.argv[2] ?? "");
if (process.argv[2] === undefined || artifactRoot === repositoryRoot) {
  process.stderr.write("usage: phase2d-corrective4-write-fixture.mjs <artifact-dir>\n");
  process.exitCode = 1;
} else {
  try {
    writeSyntheticArtifact(repositoryRoot, artifactRoot);
    process.stdout.write(
      `synthetic fixture written to ${path.relative(repositoryRoot, artifactRoot) || "."}\n`,
    );
  } catch (error) {
    const message =
      error instanceof EvidenceError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
