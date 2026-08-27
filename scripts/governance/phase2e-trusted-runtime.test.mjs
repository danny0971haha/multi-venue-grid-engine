import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandArgv,
  evaluateNpmTestOutput,
  evaluateToolchain,
  parseDryRunLiveExchangeWrites,
  runPhase2eTrustedRuntime,
} from "./phase2e-trusted-runtime.mjs";
import {
  PHASE2E_FORBIDDEN_RUNTIME_COMMANDS,
  PHASE2E_REQUIRED_RUNTIME_COMMANDS,
} from "./phase2e-trusted-freeze-lib.mjs";

describe("Phase 2E trusted runtime policy", () => {
  it("maps required commands without a shell and excludes the Phase 2D verifier", () => {
    assert.deepEqual(commandArgv("npm ci"), { file: "npm", args: ["ci"] });
    assert.deepEqual(commandArgv("npm test"), { file: "npm", args: ["test"] });
    assert.deepEqual(commandArgv("npm run test:phase2e"), {
      file: "npm",
      args: ["run", "test:phase2e"],
    });
    assert.equal(PHASE2E_REQUIRED_RUNTIME_COMMANDS.includes("npm test"), true);
    assert.equal(
      PHASE2E_REQUIRED_RUNTIME_COMMANDS.includes("npm run evidence:phase2d-corrective4:verify"),
      false,
    );
    assert.equal(
      PHASE2E_FORBIDDEN_RUNTIME_COMMANDS.includes("npm run evidence:phase2d-corrective4:verify"),
      true,
    );
  });

  it("requires pinned Node and npm versions", () => {
    const baseline = { requiredNodeVersion: "v22.23.2", requiredNpmVersion: "10.9.8" };
    assert.equal(
      evaluateToolchain({ nodeVersion: "v22.23.2", npmVersion: "10.9.8", baseline }).ok,
      true,
    );
    assert.equal(
      evaluateToolchain({ nodeVersion: "v22.23.1", npmVersion: "10.9.8", baseline }).ok,
      false,
    );
  });

  it("requires dry-run liveExchangeWrites=false", () => {
    const ok = parseDryRunLiveExchangeWrites(
      `${JSON.stringify({ runtimeMode: "DRY_RUN", liveExchangeWrites: false })}\n`,
    );
    assert.equal(ok.ok, true);
    const live = parseDryRunLiveExchangeWrites(
      `${JSON.stringify({ runtimeMode: "DRY_RUN", liveExchangeWrites: true })}\n`,
    );
    assert.equal(live.ok, false);
  });

  it("does not treat frozen Phase 2D evidence identity TAP failures as Phase 2E success evidence", () => {
    const tap = [
      "not ok 1 - PACKAGE_SCRIPT",
      "  ---",
      "  location: '/work/test/evidence/phase2d-corrective4-evidence.test.ts:10:1'",
      "  ...",
      "# fail 1",
    ].join("\n");
    const ignored = evaluateNpmTestOutput({
      exitCode: 1,
      stdout: tap,
      stderr: "",
      ignoredFileSuffix: "test/evidence/phase2d-corrective4-evidence.test.ts",
    });
    assert.equal(ignored.ok, true);
    assert.equal(ignored.ignoredEvidenceFailures, 1);
    const unexpected = evaluateNpmTestOutput({
      exitCode: 1,
      stdout: [
        "not ok 1 - halt failed",
        "  ---",
        "  location: '/work/test/halt/p2-h-matrix.test.ts:4:1'",
        "  ...",
      ].join("\n"),
      stderr: "",
      ignoredFileSuffix: "test/evidence/phase2d-corrective4-evidence.test.ts",
    });
    assert.equal(unexpected.ok, false);
  });

  it("rejects a baseline loaded from the candidate checkout", () => {
    const result = runPhase2eTrustedRuntime({
      candidateRoot: "/tmp/candidate",
      baselinePath: "/tmp/candidate/.github/trusted/phase2e-corrective1-baseline.json",
      evidencePath: null,
      writeFile() {},
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("candidate_controlled_baseline_rejected"));
  });
});
