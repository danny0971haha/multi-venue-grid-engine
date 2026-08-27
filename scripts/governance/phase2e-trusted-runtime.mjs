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
  dependencyIdentityMatches,
  parsePhase2eBaseline,
  parsePackageJsonObject,
  sha256Bytes,
} from "./phase2e-trusted-freeze-lib.mjs";

export function commandArgv(command) {
  if (command === "npm ci") return { file: "npm", args: ["ci"] };
  if (command === "npm test") return { file: "npm", args: ["test"] };
  if (command.startsWith("npm run ")) {
    return { file: "npm", args: ["run", command.slice("npm run ".length)] };
  }
  return null;
}

export function evaluateNpmTestOutput({ exitCode, stdout, stderr, ignoredFileSuffix }) {
  if (exitCode === 0) {
    return { ok: true, ignoredEvidenceFailures: 0, reason: null };
  }
  const text = `${stdout}\n${stderr}`;
  const locations = [...text.matchAll(/^\s+location:\s+'([^']+)'/gm)].map((match) => match[1]);
  if (locations.length === 0) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_failures_unparsed" };
  }
  const unexpected = locations.filter((location) => !location.includes(ignoredFileSuffix));
  if (unexpected.length > 0) {
    return { ok: false, ignoredEvidenceFailures: 0, reason: "npm_test_unexpected_failure" };
  }
  return {
    ok: true,
    ignoredEvidenceFailures: locations.length,
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
      env: { ...process.env, GITHUB_TOKEN: "", NODE_AUTH_TOKEN: "" },
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      exitCode: typeof error.status === "number" ? error.status : 1,
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
      const entry = { command, exitCode: result.exitCode };
      if (command === "npm test") {
        const disposition = evaluateNpmTestOutput({
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          ignoredFileSuffix: baseline.npmTestIgnoredTapFileSuffix,
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
