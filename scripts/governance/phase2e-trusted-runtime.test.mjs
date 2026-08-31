import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandArgv,
  evaluateNpmTestOutput,
  evaluatePhase2eSuiteOutput,
  evaluateToolchain,
  locationMatchesTestFile,
  parseDryRunLiveExchangeWrites,
  parseNodeTapStdout,
  runPhase2eTrustedRuntime,
} from "./phase2e-trusted-runtime.mjs";
import {
  PHASE2E_FORBIDDEN_RUNTIME_COMMANDS,
  PHASE2E_NPM_TEST_HISTORICAL_MISMATCH as TAP,
  PHASE2E_REQUIRED_RUNTIME_COMMANDS,
  PHASE2E_TRUSTED_BASELINE_PATH,
} from "./phase2e-trusted-freeze-lib.mjs";

function yaml(fields, indent = 0) {
  const pad = " ".repeat(indent);
  const lines = [`${pad}---`];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "error") {
      lines.push(`${pad}error: |-`);
      for (const errorLine of String(value).split("\n")) {
        lines.push(`${pad}  ${errorLine}`);
      }
      continue;
    }
    if (typeof value === "string") lines.push(`${pad}${key}: '${value}'`);
    else lines.push(`${pad}${key}: ${value}`);
  }
  lines.push(`${pad}...`);
  return lines.join("\n");
}

function greenTap(overrides = {}) {
  const lines = [
    "TAP version 13",
    "ok 1 - bootstrap",
    yaml({ duration_ms: 1, type: "test" }),
    "# Subtest: Phase 2D Corrective 4 evidence verifier",
    "    ok 1 - E4-00 Corrective 4 focused suite still has 15 named tests and no skips",
    yaml({ duration_ms: 1, type: "test" }, 4),
    "    1..1",
    "ok 13 - Phase 2D Corrective 4 evidence verifier",
    yaml({ duration_ms: 1, type: "suite" }),
  ];
  if (overrides.extra) lines.push(overrides.extra);
  lines.push(`1..${overrides.plan ?? 257}`);
  lines.push(`# tests ${overrides.tests ?? TAP.expectedTapTests}`);
  lines.push(`# pass ${overrides.pass ?? TAP.expectedTapPass}`);
  lines.push(`# fail ${overrides.fail ?? TAP.expectedTapFail}`);
  lines.push(`# cancelled ${overrides.cancelled ?? TAP.expectedTapCancelled}`);
  lines.push(`# skipped ${overrides.skipped ?? TAP.expectedTapSkipped}`);
  lines.push(`# todo ${overrides.todo ?? TAP.expectedTapTodo}`);
  return lines.join("\n");
}

function historicalCorrective1Tap() {
  const names = [
    "E4-01 handwritten intact fixture verifies without a gate verdict",
    "I-01 push sourceHeadSha does not equal GITHUB_SHA",
  ];
  const lines = ["TAP version 13", "ok 1 - bootstrap", yaml({ duration_ms: 1, type: "test" })];
  names.forEach((name, index) => {
    lines.push(`    not ok ${index + 1} - ${name}`);
    lines.push(
      yaml(
        {
          duration_ms: 1,
          type: "test",
          location: `/work/${TAP.testFilePath}:${200 + index}:3`,
          failureType: "testCodeFailure",
          error: "PACKAGE_SCRIPT: identity",
          code: "ERR_ASSERTION",
        },
        4,
      ),
    );
  });
  lines.push("    1..2");
  lines.push("not ok 13 - Phase 2D Corrective 4 evidence verifier");
  lines.push(
    yaml({
      duration_ms: 1,
      type: "suite",
      location: `/work/${TAP.testFilePath}:190:1`,
      failureType: "subtestsFailed",
      error: "2 subtests failed",
      code: "ERR_TEST_FAILURE",
    }),
  );
  lines.push("1..257");
  lines.push("# tests 516");
  lines.push("# pass 473");
  lines.push("# fail 43");
  lines.push("# cancelled 0");
  lines.push("# skipped 0");
  lines.push("# todo 0");
  return lines.join("\n");
}

function evaluate(overrides = {}) {
  return evaluateNpmTestOutput({
    exitCode: overrides.exitCode ?? 0,
    signal: overrides.signal ?? null,
    stdout: overrides.stdout ?? greenTap(overrides),
    mismatch: TAP,
    candidateRoot: overrides.candidateRoot ?? "/work",
  });
}

describe("Phase 2E trusted runtime policy", () => {
  it("maps required commands without a shell and excludes the Phase 2D verifier", () => {
    assert.deepEqual(commandArgv("npm ci"), { file: "npm", args: ["ci"] });
    assert.deepEqual(commandArgv("npm test"), { file: "npm", args: ["test"] });
    assert.deepEqual(commandArgv("npm run test:phase2e"), {
      file: "npm",
      args: ["run", "test:phase2e"],
    });
    assert.deepEqual(
      [...PHASE2E_REQUIRED_RUNTIME_COMMANDS],
      [
        "npm ci",
        "npm run typecheck",
        "npm run lint",
        "npm run format:check",
        "npm test",
        "npm run test:phase2e",
        "npm run build",
        "npm run scan:secrets",
        "npm run dry-run",
      ],
    );
    assert.equal(PHASE2E_REQUIRED_RUNTIME_COMMANDS.includes("npm test"), true);
    assert.equal(
      PHASE2E_REQUIRED_RUNTIME_COMMANDS.includes("npm run test:phase2d-corrective-4"),
      false,
    );
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

  it("accepts only the pinned green Runtime Corrective 3 npm test TAP", () => {
    const parsed = parseNodeTapStdout(greenTap());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.failedTests.length, 0);
    const accepted = evaluate();
    assert.equal(accepted.ok, true);
    assert.equal(accepted.ignoredEvidenceFailures, 0);
    assert.equal(accepted.reason, "npm_test_all_passed");
  });

  it("fail closed on the invalidated Corrective 1 historical TAP", () => {
    const result = evaluate({ exitCode: 1, stdout: historicalCorrective1Tap() });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "npm_test_exit_mismatch");
    const sameExit = evaluate({ exitCode: 0, stdout: historicalCorrective1Tap() });
    assert.equal(sameExit.ok, false);
    assert.equal(sameExit.reason, "npm_test_tap_counts_mismatch");
  });

  it("fail closed on stderr-only location spoofs and missing stdout TAP", () => {
    const stderrSpoof = evaluateNpmTestOutput({
      exitCode: 0,
      stdout: "tsx crashed before TAP\n",
      mismatch: TAP,
      candidateRoot: "/work",
    });
    assert.equal(stderrSpoof.ok, false);
    assert.equal(stderrSpoof.reason, "npm_test_tap_version_missing");
    const empty = evaluate({ exitCode: 0, stdout: "" });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "npm_test_output_missing");
  });

  it("fail closed on exit 1 even when TAP claims a green run", () => {
    const result = evaluate({ exitCode: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "npm_test_exit_mismatch");
  });

  it("fail closed on a new failure inside the evidence file", () => {
    const extra = [
      "not ok 99 - NEW_SUBSTANTIVE_FAILURE",
      yaml({
        duration_ms: 1,
        type: "test",
        location: `/work/${TAP.testFilePath}:10:1`,
        failureType: "testCodeFailure",
        error: "PACKAGE_SCRIPT: identity",
        code: "ERR_ASSERTION",
      }),
    ].join("\n");
    const result = evaluate({ extra, fail: 1, tests: 475, pass: 474 });
    assert.equal(result.ok, false);
  });

  it("fail closed on a second file failure", () => {
    const extra = [
      "not ok 99 - halt failed",
      yaml({
        duration_ms: 1,
        type: "test",
        location: "/work/test/halt/p2-h-matrix.test.ts:4:1",
        failureType: "testCodeFailure",
        error: "halt blew up",
        code: "ERR_ASSERTION",
      }),
    ].join("\n");
    const result = evaluate({ extra, fail: 1, tests: 475, pass: 474 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "npm_test_tap_counts_mismatch");
    const sameCounts = evaluate({ extra });
    assert.equal(sameCounts.ok, false);
  });

  it("fail closed on skip, todo, cancelled, signal, and missing plan", () => {
    assert.equal(evaluate({ skipped: 1 }).ok, false);
    assert.equal(evaluate({ todo: 1 }).ok, false);
    assert.equal(evaluate({ cancelled: 1 }).ok, false);
    const skipDirective = evaluate({
      extra: "ok 200 - safety # SKIP\n",
    });
    assert.equal(skipDirective.ok, false);
    assert.equal(skipDirective.reason, "npm_test_skipped_or_todo");
    const signaled = evaluate({ signal: "SIGKILL" });
    assert.equal(signaled.ok, false);
    assert.equal(signaled.reason, "npm_test_signal_exit");
    const noPlan = evaluate({
      stdout: greenTap().replace(/^1\.\.257$/m, ""),
    });
    assert.equal(noPlan.ok, false);
    assert.equal(noPlan.reason, "npm_test_tap_plan_missing");
  });

  it("fail closed on skip or todo in the dedicated Phase 2E suite", () => {
    const skipped = evaluatePhase2eSuiteOutput({
      exitCode: 0,
      signal: null,
      stdout: greenTap({ skipped: 1, tests: 79, pass: 78 }),
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.reason, "phase2e_test_skipped_or_todo");
    const failed = evaluatePhase2eSuiteOutput({
      exitCode: 1,
      signal: null,
      stdout: greenTap({ fail: 1, tests: 79, pass: 78 }),
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, "phase2e_test_exit_mismatch");
    const green = evaluatePhase2eSuiteOutput({
      exitCode: 0,
      signal: null,
      stdout: greenTap({ tests: 79, pass: 79, fail: 0 }),
    });
    assert.equal(green.ok, true);
  });

  it("fail closed on a different assertion identity or file path", () => {
    const extra = [
      "not ok 99 - halt failed",
      yaml({
        duration_ms: 1,
        type: "test",
        location: "/tmp/not-a-test/test/evidence/phase2d-corrective4-evidence.test.ts:1:1",
        failureType: "testCodeFailure",
        error: "some other assertion",
        code: "ERR_ASSERTION",
      }),
    ].join("\n");
    const prefixSpoof = evaluate({ extra });
    assert.equal(prefixSpoof.ok, false);
    assert.equal(prefixSpoof.reason, "npm_test_unexpected_failure");
    assert.equal(
      locationMatchesTestFile(`/work/${TAP.testFilePath}:10:1`, TAP.testFilePath, "/work"),
      true,
    );
  });

  it("rejects a baseline loaded from the candidate checkout", () => {
    const result = runPhase2eTrustedRuntime({
      candidateRoot: "/tmp/candidate",
      baselinePath: `/tmp/candidate/${PHASE2E_TRUSTED_BASELINE_PATH}`,
      evidencePath: null,
      writeFile() {},
    });
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes("candidate_controlled_baseline_rejected"));
  });
});
