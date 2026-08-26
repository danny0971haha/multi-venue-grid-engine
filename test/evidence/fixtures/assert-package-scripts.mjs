import process from "node:process";

import {
  EXPECTED_DRY_RUN_SCRIPT,
  EXPECTED_NPM_CORRECTIVE4_SCRIPT,
  EXPECTED_NPM_EVIDENCE_SCRIPT,
  EXPECTED_NPM_TEST_SCRIPT,
  EvidenceError,
} from "../../../scripts/evidence/phase2d-corrective4-schema.mjs";
import { assertPackageScripts } from "../../../scripts/evidence/phase2d-corrective4-verify-lib.mjs";

const mode = process.argv[2];

try {
  if (mode === "removed-evidence") {
    assertPackageScripts({
      scripts: {
        test: EXPECTED_NPM_TEST_SCRIPT.replace(" test/evidence/*.test.ts", ""),
        "test:phase2d-corrective-4": EXPECTED_NPM_CORRECTIVE4_SCRIPT,
        "test:evidence:phase2d-corrective4": EXPECTED_NPM_EVIDENCE_SCRIPT,
        "dry-run": EXPECTED_DRY_RUN_SCRIPT,
      },
    });
    process.stderr.write("expected PACKAGE_SCRIPT\n");
    process.exitCode = 1;
  } else if (mode === "synthetic-tap") {
    assertPackageScripts({
      scripts: {
        test: "node -e \"process.stdout.write('# tests 428\\n# pass 428\\n')\"",
        "test:phase2d-corrective-4": EXPECTED_NPM_CORRECTIVE4_SCRIPT,
        "test:evidence:phase2d-corrective4": EXPECTED_NPM_EVIDENCE_SCRIPT,
        "dry-run": EXPECTED_DRY_RUN_SCRIPT,
      },
    });
    process.stderr.write("expected PACKAGE_SCRIPT\n");
    process.exitCode = 1;
  } else {
    process.stderr.write("usage: assert-package-scripts.mjs <removed-evidence|synthetic-tap>\n");
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof EvidenceError) {
    process.stdout.write(`${error.code}\n`);
    process.exitCode = error.code === "PACKAGE_SCRIPT" ? 2 : 1;
    process.exit(process.exitCode);
  }
  throw error;
}
