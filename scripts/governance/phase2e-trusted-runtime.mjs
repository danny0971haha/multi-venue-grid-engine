#!/usr/bin/env node
/**
 * Trusted Phase 2E runtime command runner.
 * Must be copied out of the workspace before the candidate checkout.
 * Reads the trusted baseline from TRUSTED_PHASE2E_BASELINE, never from the
 * candidate tree. Does not run the Phase 2D evidence verifier.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PHASE2E_NPM_TEST_HISTORICAL_MISMATCH,
  dependencyIdentityMatches,
  parsePhase2eBaseline,
  parsePackageJsonObject,
  sha256Bytes,
} from "./phase2e-trusted-freeze-lib.mjs";

const RUNTIME_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const TEST_POINT_RE = /^( *)(not )?ok(?:\s+(\d+))?\s+-\s+(.+)$/;
const TAP_SUMMARY_RE = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/;
const YAML_KEY_RE = /^(\s*)([A-Za-z_][\w]*)\s*:\s*(.*)$/;

export function commandArgv(command) {
  if (command === "npm ci") return { file: "npm", args: ["ci"] };
  if (command === "npm test") return { file: "npm", args: ["test"] };
  if (command.startsWith("npm run ")) {
    return { file: "npm", args: ["run", command.slice("npm run ".length)] };
  }
  return null;
}

export function tapLocationFilePath(location) {
  if (typeof location !== "string" || location.length === 0) return null;
  return location.replaceAll("\\", "/").replace(/:\d+:\d+$/, "");
}

export function locationMatchesTestFile(location, testFilePath, candidateRoot) {
  const filePath = tapLocationFilePath(location);
  if (!filePath || typeof testFilePath !== "string" || typeof candidateRoot !== "string") {
    return false;
  }
  return path.resolve(filePath) === path.resolve(candidateRoot, testFilePath);
}

export function parseNodeTapStdout(stdout) {
  if (typeof stdout !== "string" || stdout.trim().length === 0) {
    return { ok: false, reason: "npm_test_output_missing" };
  }
  const lines = stdout.split(/\r?\n/);
  if (!lines.some((line) => line.trim() === "TAP version 13")) {
    return { ok: false, reason: "npm_test_tap_version_missing" };
  }

  const summary = {
    tests: null,
    pass: null,
    fail: null,
    cancelled: null,
    skipped: null,
    todo: null,
  };
  const failedTests = [];
  const failedSuites = [];
  let sawPlan = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const summaryMatch = TAP_SUMMARY_RE.exec(line.trim());
    if (summaryMatch) {
      summary[summaryMatch[1]] = Number(summaryMatch[2]);
      i += 1;
      continue;
    }
    if (/^1\.\.\d+\s*$/.test(line)) {
      sawPlan = true;
      i += 1;
      continue;
    }
    const point = TEST_POINT_RE.exec(line);
    if (!point) {
      i += 1;
      continue;
    }
    const failed = Boolean(point[2]);
    const rawName = point[4];
    const directiveMatch = /\s+#\s*(SKIP|TODO)\b/i.exec(rawName);
    if (directiveMatch) {
      return { ok: false, reason: "npm_test_skipped_or_todo" };
    }
    const name = rawName.trim();
    i += 1;
    if (i >= lines.length || lines[i].trim() !== "---") {
      if (failed) return { ok: false, reason: "npm_test_tap_yaml_missing" };
      continue;
    }
    const yamlResult = parseTapYamlBlock(lines, i);
    if (!yamlResult.ok) return yamlResult;
    i = yamlResult.nextIndex;
    const yaml = yamlResult.yaml;
    if (yaml.skip !== undefined || yaml.todo !== undefined) {
      return { ok: false, reason: "npm_test_skipped_or_todo" };
    }
    if (!failed) continue;
    if (yaml.type !== "test" && yaml.type !== "suite") {
      return { ok: false, reason: "npm_test_tap_type_missing" };
    }
    const entry = {
      name,
      type: yaml.type,
      location: yaml.location ?? null,
      failureType: yaml.failureType ?? null,
      code: yaml.code ?? null,
      error: yaml.error ?? "",
    };
    if (yaml.type === "suite") failedSuites.push(entry);
    else failedTests.push(entry);
  }

  if (!sawPlan) return { ok: false, reason: "npm_test_tap_plan_missing" };
  for (const key of Object.keys(summary)) {
    if (!Number.isInteger(summary[key])) {
      return { ok: false, reason: "npm_test_tap_summary_missing" };
    }
  }
  return { ok: true, reason: null, summary, failedTests, failedSuites };
}

function parseTapYamlBlock(lines, startIndex) {
  const yamlLines = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    if (lines[i].trim() === "...") {
      const yaml = parseSimpleTapYaml(yamlLines);
      if (!yaml.ok) return yaml;
      return { ok: true, yaml: yaml.value, nextIndex: i + 1 };
    }
    yamlLines.push(lines[i]);
    i += 1;
  }
  return { ok: false, reason: "npm_test_tap_yaml_unterminated" };
}

function parseSimpleTapYaml(yamlLines) {
  const value = {};
  let i = 0;
  while (i < yamlLines.length) {
    const line = yamlLines[i];
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }
    const match = YAML_KEY_RE.exec(line);
    if (!match) return { ok: false, reason: "npm_test_tap_yaml_malformed" };
    const key = match[2];
    const raw = match[3];
    if (raw === "|-" || raw === "|") {
      const blockIndent = match[1].length;
      const block = [];
      i += 1;
      while (i < yamlLines.length) {
        const next = yamlLines[i];
        if (next.trim().length === 0) {
          block.push("");
          i += 1;
          continue;
        }
        const nextIndent = next.match(/^(\s*)/)[1].length;
        if (nextIndent <= blockIndent && YAML_KEY_RE.test(next)) break;
        block.push(next.slice(blockIndent + 2));
        i += 1;
      }
      value[key] = block.join("\n");
      continue;
    }
    value[key] = unquoteYamlScalar(raw);
    i += 1;
  }
  return { ok: true, value };
}

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

export function evaluateNpmTestOutput({ exitCode, signal, stdout, mismatch, candidateRoot }) {
  const pinned = mismatch ?? PHASE2E_NPM_TEST_HISTORICAL_MISMATCH;
  if (signal) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_signal_exit" };
  }
  if (!Number.isInteger(exitCode)) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_abnormal_exit" };
  }
  if (typeof candidateRoot !== "string" || candidateRoot.length === 0) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_candidate_root_missing" };
  }
  const parsed = parseNodeTapStdout(stdout);
  if (!parsed.ok) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: parsed.reason };
  }
  if (
    parsed.summary.cancelled !== pinned.expectedTapCancelled ||
    parsed.summary.skipped !== pinned.expectedTapSkipped ||
    parsed.summary.todo !== pinned.expectedTapTodo
  ) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_skipped_or_todo" };
  }
  if (exitCode !== pinned.expectedExitCode) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_exit_mismatch" };
  }
  if (
    parsed.summary.tests !== pinned.expectedTapTests ||
    parsed.summary.pass !== pinned.expectedTapPass ||
    parsed.summary.fail !== pinned.expectedTapFail
  ) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_tap_counts_mismatch" };
  }
  if (parsed.failedTests.length !== pinned.expectedFailureNames.length) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_failure_count_mismatch" };
  }
  if (parsed.failedSuites.length !== 1) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_unexpected_suite_failure" };
  }
  const suite = parsed.failedSuites[0];
  if (
    suite.name !== pinned.expectedSuiteFailureName ||
    suite.failureType !== pinned.expectedSuiteFailureType ||
    suite.code !== pinned.expectedSuiteFailureCode ||
    !locationMatchesTestFile(suite.location, pinned.testFilePath, candidateRoot)
  ) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_suite_failure_mismatch" };
  }
  for (let index = 0; index < parsed.failedTests.length; index += 1) {
    const failure = parsed.failedTests[index];
    if (failure.name !== pinned.expectedFailureNames[index]) {
      return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_failure_name_mismatch" };
    }
    if (!locationMatchesTestFile(failure.location, pinned.testFilePath, candidateRoot)) {
      return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_unexpected_failure" };
    }
    if (failure.failureType !== pinned.expectedFailureType) {
      return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_failure_type_mismatch" };
    }
    if (failure.code !== pinned.expectedFailureCode) {
      return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_failure_code_mismatch" };
    }
    if (!failure.error.includes(pinned.expectedErrorSubstring)) {
      return {
        ok: false,
        ignoredEvidenceFailures: 0,
        reason: "npm_test_failure_identity_mismatch",
      };
    }
  }
  return {
    ok: true,
    ignoredEvidenceFailures: parsed.failedTests.length,
    reason: "phase2d_evidence_identity_failures_not_used_as_phase2e_result",
  };
}

export function parseDryRunLiveExchangeWrites(stdout) {
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, reason: "dry_run_output_missing", liveExchangeWrites: null };
  }
  try {
    const parsed = JSON.parse(lines[lines.length - 1]);
    if (parsed?.liveExchangeWrites !== false || parsed?.runtimeMode !== "DRY_RUN") {
      return {
        ok: false,
        reason: "dry_run_live_exchange_not_false",
        liveExchangeWrites: parsed?.liveExchangeWrites,
      };
    }
    return { ok: true, reason: null, liveExchangeWrites: false };
  } catch {
    return { ok: false, reason: "dry_run_output_malformed", liveExchangeWrites: null };
  }
}

export function evaluateToolchain({ nodeVersion, npmVersion, baseline }) {
  if (nodeVersion !== baseline.requiredNodeVersion) {
    return { ok: false, reason: "node_version_mismatch" };
  }
  if (npmVersion !== baseline.requiredNpmVersion) {
    return { ok: false, reason: "npm_version_mismatch" };
  }
  return { ok: true, reason: null };
}

function runCaptured(file, args, cwd) {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUNTIME_COMMAND_TIMEOUT_MS,
      killSignal: "SIGTERM",
      env: { ...process.env, GITHUB_TOKEN: "", NODE_AUTH_TOKEN: "" },
    });
    return { exitCode: 0, signal: null, stdout, stderr: "" };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.status) ? error.status : null,
      signal: error.signal ?? (error.killed ? "SIGTERM" : null),
      stdout: error.stdout?.toString?.() ?? "",
      stderr: error.stderr?.toString?.() ?? "",
    };
  }
}

function verifyCandidateIdentity(candidateRoot, baseline) {
  const lockBytes = readFileSync(path.join(candidateRoot, "package-lock.json"));
  const lockSha256 = sha256Bytes(lockBytes);
  if (lockSha256 !== baseline.packageLock.sha256) {
    return { ok: false, reason: "package_lock_sha256_mismatch_after_runtime" };
  }
  const pkg = parsePackageJsonObject(
    readFileSync(path.join(candidateRoot, "package.json"), "utf8"),
  );
  if (!pkg.ok) return { ok: false, reason: pkg.reason };
  if (!dependencyIdentityMatches(baseline, pkg.value)) {
    return { ok: false, reason: "package_json_dependency_identity_mismatch_after_runtime" };
  }
  return { ok: true, reason: null };
}

export function runPhase2eTrustedRuntime({
  candidateRoot,
  baselinePath,
  evidencePath,
  execCommand = runCaptured,
  readFile = readFileSync,
  writeFile = writeFileSync,
} = {}) {
  const reasons = [];
  if (typeof candidateRoot !== "string" || typeof baselinePath !== "string") {
    return fail("runtime_input_invalid", evidencePath, writeFile, reasons);
  }
  const resolvedCandidate = path.resolve(candidateRoot);
  const resolvedBaseline = path.resolve(baselinePath);
  if (
    resolvedBaseline === resolvedCandidate ||
    resolvedBaseline.startsWith(`${resolvedCandidate}${path.sep}`)
  ) {
    return fail("candidate_controlled_baseline_rejected", evidencePath, writeFile, reasons);
  }

  let parsed;
  try {
    parsed = parsePhase2eBaseline(readFile(resolvedBaseline, "utf8"));
  } catch {
    return fail("phase2e_baseline_unreadable", evidencePath, writeFile, reasons);
  }
  if (!parsed.ok) {
    return fail(parsed.reasons.join(","), evidencePath, writeFile, reasons);
  }
  const baseline = parsed.baseline;

  const nodeVersion = execCommand("node", ["--version"], resolvedCandidate);
  const npmVersion = execCommand("npm", ["--version"], resolvedCandidate);
  const toolchain = evaluateToolchain({
    nodeVersion: nodeVersion.stdout.trim(),
    npmVersion: npmVersion.stdout.trim(),
    baseline,
  });
  if (!toolchain.ok) reasons.push(toolchain.reason);

  const commandResults = [];
  let dryRunLiveExchangeWrites = null;
  let npmTestIgnoredEvidenceFailures = 0;

  if (reasons.length === 0) {
    for (const command of baseline.requiredRuntimeCommands) {
      if (baseline.forbiddenRuntimeCommands.includes(command)) {
        reasons.push("forbidden_runtime_command_in_required_list");
        break;
      }
      const argv = commandArgv(command);
      if (!argv) {
        reasons.push("required_command_unmapped");
        break;
      }
      const result = execCommand(argv.file, argv.args, resolvedCandidate);
      const entry = { command, exitCode: result.exitCode, signal: result.signal ?? null };
      if (result.signal) {
        entry.ok = false;
        reasons.push(`command_signal:${command}`);
        commandResults.push(entry);
        break;
      }
      if (command === "npm test") {
        const disposition = evaluateNpmTestOutput({
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          mismatch: baseline.npmTestHistoricalMismatch,
          candidateRoot: resolvedCandidate,
        });
        entry.ok = disposition.ok;
        entry.npmTestReason = disposition.reason;
        npmTestIgnoredEvidenceFailures = disposition.ignoredEvidenceFailures;
        if (!disposition.ok) reasons.push(disposition.reason);
      } else if (command === "npm run dry-run") {
        const dry = parseDryRunLiveExchangeWrites(result.stdout);
        dryRunLiveExchangeWrites = dry.liveExchangeWrites;
        entry.ok = result.exitCode === 0 && dry.ok;
        if (result.exitCode !== 0) reasons.push("dry_run_command_failed");
        if (!dry.ok) reasons.push(dry.reason);
      } else if (result.exitCode !== 0) {
        entry.ok = false;
        reasons.push(`command_failed:${command}`);
      } else {
        entry.ok = true;
      }
      commandResults.push(entry);
      if (reasons.length > 0) break;
    }
  }

  const identity = verifyCandidateIdentity(resolvedCandidate, baseline);
  if (!identity.ok) reasons.push(identity.reason);

  const ok = reasons.length === 0;
  const evidence = {
    phase2eTrustedRuntimeOk: ok,
    candidateHeadSha: baseline.candidateHeadSha,
    dryRunLiveExchangeWrites,
    npmTestIgnoredEvidenceFailures,
    phase2dEvidenceVerifierExecuted: false,
    commandResults,
    reasons,
  };
  if (evidencePath) {
    writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  process.stdout.write(
    `${[
      `phase2eTrustedRuntimeOk=${ok ? "true" : "false"}`,
      `dryRunLiveExchangeWrites=${dryRunLiveExchangeWrites === false ? "false" : "unknown"}`,
      `phase2dEvidenceVerifierExecuted=false`,
      `reasonCodes=${reasons.join(",")}`,
    ].join("\n")}\n`,
  );
  return { ok, reasons, evidence };
}

function fail(reason, evidencePath, writeFile, reasons) {
  reasons.push(reason);
  const evidence = {
    phase2eTrustedRuntimeOk: false,
    phase2dEvidenceVerifierExecuted: false,
    reasons,
  };
  if (evidencePath) writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`phase2eTrustedRuntimeOk=false\nreasonCodes=${reasons.join(",")}\n`);
  return { ok: false, reasons, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runPhase2eTrustedRuntime({
    candidateRoot: process.env.PHASE2E_CANDIDATE_ROOT || process.cwd(),
    baselinePath: process.env.TRUSTED_PHASE2E_BASELINE,
    evidencePath: process.env.PHASE2E_EVIDENCE_PATH,
  });
  process.exit(result.ok ? 0 : 1);
}
