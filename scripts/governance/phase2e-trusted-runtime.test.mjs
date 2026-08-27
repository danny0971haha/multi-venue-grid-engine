import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commandArgv,
  evaluateNpmTestOutput,
  evaluateToolchain,
  locationMatchesTestFile,
  parseDryRunLiveExchangeWrites,
  parseNodeTapStdout,
  runPhase2eTrustedRuntime,
} from "./phase2e-trusted-runtime.mjs";
import {
  PHASE2E_FORBIDDEN_RUNTIME_COMMANDS,
  PHASE2E_NPM_TEST_HISTORICAL_MISMATCH as MISMATCH,
  PHASE2E_REQUIRED_RUNTIME_COMMANDS,
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

function historicalTap(overrides = {}) {
  const names = overrides.failureNames ?? [...MISMATCH.expectedFailureNames];
  const lines = [
    "TAP version 13",
    "ok 1 - bootstrap",
    yaml({ duration_ms: 1, type: "test" }),
    "# Subtest: Phase 2D Corrective 4 evidence verifier",
    "    ok 1 - E4-00 Corrective 4 focused suite still has 15 named tests and no skips",
    yaml({ duration_ms: 1, type: "test" }, 4),
  ];
  names.forEach((name, index) => {
    lines.push(`    not ok ${index + 2} - ${name}`);
    lines.push(
      yaml(
        {
          duration_ms: 1,
          type: "test",
          location: overrides.failureLocation ?? `/work/${MISMATCH.testFilePath}:${200 + index}:3`,
          failureType: overrides.failureType ?? MISMATCH.expectedFailureType,
          error: overrides.error ?? `${MISMATCH.expectedErrorSubstring}: identity`,
          code: overrides.failureCode ?? MISMATCH.expectedFailureCode,
        },
        4,
      ),
    );
  });
  lines.push("    1..46");
  if (overrides.omitSuite !== true) {
    lines.push(`not ok 13 - ${overrides.suiteName ?? MISMATCH.expectedSuiteFailureName}`);
    lines.push(
      yaml({
        duration_ms: 1,
        type: "suite",
        location: overrides.suiteLocation ?? `/work/${MISMATCH.testFilePath}:190:1`,
        failureType: overrides.suiteFailureType ?? MISMATCH.expectedSuiteFailureType,
        error: "43 subtests failed",
        code: overrides.suiteFailureCode ?? MISMATCH.expectedSuiteFailureCode,
      }),
    );
  }
  if (overrides.extra) lines.push(overrides.extra);
  lines.push(`1..${overrides.plan ?? 257}`);
  lines.push(`# tests ${overrides.tests ?? MISMATCH.expectedTapTests}`);
  lines.push(`# pass ${overrides.pass ?? MISMATCH.expectedTapPass}`);
  lines.push(`# fail ${overrides.fail ?? MISMATCH.expectedTapFail}`);
  lines.push(`# cancelled ${overrides.cancelled ?? MISMATCH.expectedTapCancelled}`);
  lines.push(`# skipped ${overrides.skipped ?? MISMATCH.expectedTapSkipped}`);
  lines.push(`# todo ${overrides.todo ?? MISMATCH.expectedTapTodo}`);
  return lines.join("\n");
}

function evaluate(overrides = {}) {
  return evaluateNpmTestOutput({
    exitCode: overrides.exitCode ?? 1,
    signal: overrides.signal ?? null,
    stdout: overrides.stdout ?? historicalTap(overrides),
    mismatch: MISMATCH,
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

  it("accepts only the pinned Runtime Corrective 1 evidence identity failures", () => {
    const parsed = parseNodeTapStdout(historicalTap());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.failedTests.length, 43);
    const accepted = evaluate();
    assert.equal(accepted.ok, true);
    assert.equal(accepted.ignoredEvidenceFailures, 43);
    assert.equal(accepted.reason, "phase2d_evidence_identity_failures_not_used_as_phase2e_result");
  });

  it("fail closed on stderr-only location spoofs and missing stdout TAP", () => {
    const stderrSpoof = evaluateNpmTestOutput({
      exitCode: 1,
      stdout: "tsx crashed before TAP\n",
      mismatch: MISMATCH,
      candidateRoot: "/work",
    });
    assert.equal(stderrSpoof.ok, false);
    assert.equal(stderrSpoof.reason, "npm_test_tap_version_missing");
    const empty = evaluate({ exitCode: 0, stdout: "" });
    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "npm_test_output_missing");
  });

  it("fail closed on exit 0 even when TAP claims the historical failures", () => {
    const result = evaluate({ exitCode: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "npm_test_exit_mismatch");
  });

  it("fail closed on a new failure inside the evidence file", () => {
    const names = [...MISMATCH.expectedFailureNames, "NEW_SUBSTANTIVE_FAILURE"];
    const result = evaluate({ failureNames: names, fail: 44, tests: 517, pass: 473 });
    assert.equal(result.ok, false);
  });

  it("fail closed when a halt failure is hidden by an evidence location line", () => {
    const extra = [
      "not ok 99 - halt failed",
      yaml({
        duration_ms: 1,
        type: "test",
        location: `/work/${MISMATCH.testFilePath}:10:1`,
        failureType: MISMATCH.expectedFailureType,
        error: `${MISMATCH.expectedErrorSubstring}: hidden halt`,
        code: MISMATCH.expectedFailureCode,
      }),
    ].join("\n");
    const result = evaluate({ extra, fail: 44, tests: 517 });
    assert.equal(result.ok, false);
  });

  it("fail closed on a second file failure", () => {
    const extra = [
      "not ok 99 - halt failed",
      yaml({
        duration_ms: 1,
        type: "test",
        location: "/work/test/halt/p2-h-matrix.test.ts:4:1",
        failureType: MISMATCH.expectedFailureType,
        error: "halt blew up",
        code: MISMATCH.expectedFailureCode,
      }),
    ].join("\n");
    const result = evaluate({ extra, fail: 44, tests: 517 });
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
      stdout: historicalTap().replace(/^1\.\.257$/m, ""),
    });
    assert.equal(noPlan.ok, false);
    assert.equal(noPlan.reason, "npm_test_tap_plan_missing");
  });

  it("fail closed on a different assertion identity or file path", () => {
    const wrongError = evaluate({ error: "some other assertion" });
    assert.equal(wrongError.ok, false);
    assert.equal(wrongError.reason, "npm_test_failure_identity_mismatch");
    const prefixSpoof = evaluate({
      failureLocation: "/tmp/not-a-test/test/evidence/phase2d-corrective4-evidence.test.ts:1:1",
    });
    assert.equal(prefixSpoof.ok, false);
    assert.equal(prefixSpoof.reason, "npm_test_unexpected_failure");
    const substringSpoof = evaluate({
      failureLocation: "/tmp/evil-test/evidence/phase2d-corrective4-evidence.test.ts.bak:1:1",
    });
    assert.equal(substringSpoof.ok, false);
    assert.equal(substringSpoof.reason, "npm_test_unexpected_failure");
    assert.equal(
      locationMatchesTestFile(
        `/work/${MISMATCH.testFilePath}:10:1`,
        MISMATCH.testFilePath,
        "/work",
      ),
      true,
    );
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
