#!/usr/bin/env node
/** Stable always-run required context classifier for pull requests targeting main. */

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  TRUSTED_BASELINE_PATH,
  isSafeGitPath,
  parseBaseline,
  pathMatchesAnyRule,
} from "./phase2d-trusted-freeze-lib.mjs";
import { collectPaginatedItems, repoApiRoot } from "./phase2d-trusted-freeze-github.mjs";
import {
  PHASE2E_TRUSTED_BASELINE_PATH,
  hasPhase2eSignal,
  parsePhase2eBaseline,
} from "./phase2e-trusted-freeze-lib.mjs";

export function classifyPullRequestEvent(
  event,
  changedPaths,
  { phase2dBaseline, phase2eBaseline },
) {
  const pullRequest = event?.pull_request;
  if (
    !pullRequest ||
    typeof pullRequest !== "object" ||
    !pullRequest.head ||
    !pullRequest.base ||
    !pullRequest.head.repo
  ) {
    return { mode: "FAIL_CLOSED", reason: "gate_input_invalid" };
  }
  return classifyGate({
    baseline: phase2dBaseline,
    phase2eBaseline,
    changedPaths,
    headRef: pullRequest.head.ref,
    headSha: pullRequest.head.sha,
    headRepository: pullRequest.head.repo.full_name,
    baseRepository: pullRequest.base.repo?.full_name ?? event.repository?.full_name,
    baseRef: pullRequest.base.ref,
    baseSha: pullRequest.base.sha,
    prNumber: pullRequest.number,
  });
}

export function classifyGate({
  baseline,
  phase2eBaseline = null,
  changedPaths,
  headRef,
  headSha = null,
  headRepository,
  baseRepository,
  baseRef = null,
  baseSha = null,
  prNumber = null,
}) {
  if (!baseline || !Array.isArray(changedPaths) || baseRepository !== baseline?.repository) {
    return { mode: "FAIL_CLOSED", reason: "gate_input_invalid" };
  }
  if (changedPaths.some((filePath) => typeof filePath !== "string" || !isSafeGitPath(filePath))) {
    return { mode: "FAIL_CLOSED", reason: "changed_path_unsafe" };
  }

  if (hasPhase2eSignal({ headRef, changedPaths, phase2eBaseline })) {
    return classifyPhase2e({
      phase2eBaseline,
      changedPaths,
      headRef,
      headSha,
      headRepository,
      baseRepository,
      baseRef,
      baseSha,
      prNumber,
    });
  }

  const trustedTouched = changedPaths.some((filePath) =>
    pathMatchesAnyRule(filePath, baseline.trustedGovernancePathRules),
  );
  const phase2Touched = changedPaths.some((filePath) =>
    pathMatchesAnyRule(filePath, [
      ...baseline.protectedPathRules,
      ...baseline.allowedEvidenceOnlyChangedPathRules,
    ]),
  );
  if (trustedTouched && phase2Touched) {
    return { mode: "PHASE2D_ENFORCE", reason: "phase2_and_trusted_paths_touched" };
  }
  if (headRef === baseline.candidateHeadRef || phase2Touched) {
    return { mode: "PHASE2D_ENFORCE", reason: "phase2_candidate_or_path_touched" };
  }
  if (trustedTouched) {
    if (headRepository !== baseline.repository) {
      return { mode: "FAIL_CLOSED", reason: "fork_trusted_governance_change" };
    }
    return { mode: "GOVERNANCE_REVIEW_REQUIRED", reason: "trusted_governance_path_touched" };
  }
  return { mode: "NOT_APPLICABLE", reason: "phase2_paths_not_touched" };
}

function classifyPhase2e({
  phase2eBaseline,
  changedPaths,
  headRef,
  headSha,
  headRepository,
  baseRepository,
  baseRef,
  baseSha,
  prNumber,
}) {
  if (!phase2eBaseline) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_baseline_missing" };
  }
  if (Number(prNumber) !== Number(phase2eBaseline.pullRequestNumber)) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_pr_number_mismatch" };
  }
  if (
    headRepository !== phase2eBaseline.repository ||
    baseRepository !== phase2eBaseline.repository
  ) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_repository_mismatch" };
  }
  if (headRef !== phase2eBaseline.candidateHeadRef) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_head_ref_mismatch" };
  }
  if (baseRef !== phase2eBaseline.candidateBaseRef) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_base_ref_mismatch" };
  }
  if (baseSha !== phase2eBaseline.frozenBaseSha) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_base_sha_mismatch" };
  }
  if (headSha !== phase2eBaseline.candidateHeadSha) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_head_sha_mismatch" };
  }
  if (
    changedPaths.some((filePath) =>
      pathMatchesAnyRule(filePath, phase2eBaseline.trustedGovernancePathRules),
    )
  ) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_trusted_governance_path" };
  }
  if (changedPaths.includes("package-lock.json")) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_package_lock_changed" };
  }
  const expected = [...phase2eBaseline.allowedChangedPaths].sort();
  const actual = [...changedPaths].sort();
  if (
    expected.length !== actual.length ||
    expected.some((filePath, index) => filePath !== actual[index])
  ) {
    return { mode: "FAIL_CLOSED", reason: "phase2e_changed_paths_mismatch" };
  }
  return { mode: "PHASE2E_ENFORCE", reason: "phase2e_exact_candidate" };
}

export async function runTrustedGate({
  env,
  fetchImpl,
  readFile = readFileSync,
  appendOutput = appendFileSync,
  stdoutWrite = (text) => process.stdout.write(text),
  repoRoot,
} = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = repoRoot ?? path.resolve(here, "..", "..");
  const processEnv = env ?? process.env;

  let phase2dParsed;
  try {
    phase2dParsed = parseBaseline(readFile(path.join(root, TRUSTED_BASELINE_PATH), "utf8"));
  } catch {
    return finish(
      { mode: "FAIL_CLOSED", reason: "phase2d_baseline_unreadable" },
      { appendOutput, stdoutWrite, processEnv },
    );
  }
  if (!phase2dParsed.ok) {
    return finish(
      { mode: "FAIL_CLOSED", reason: phase2dParsed.reasons.join(",") },
      { appendOutput, stdoutWrite, processEnv },
    );
  }

  let phase2eParsed;
  try {
    phase2eParsed = parsePhase2eBaseline(
      readFile(path.join(root, PHASE2E_TRUSTED_BASELINE_PATH), "utf8"),
    );
  } catch {
    return finish(
      { mode: "FAIL_CLOSED", reason: "phase2e_baseline_unreadable" },
      { appendOutput, stdoutWrite, processEnv },
    );
  }
  if (!phase2eParsed.ok) {
    return finish(
      { mode: "FAIL_CLOSED", reason: phase2eParsed.reasons.join(",") },
      { appendOutput, stdoutWrite, processEnv },
    );
  }

  const token = processEnv.GITHUB_TOKEN;
  const apiUrl = processEnv.GITHUB_API_URL || "https://api.github.com";
  const prNumber = processEnv.PR_NUMBER;
  const apiRoot = repoApiRoot(apiUrl, phase2dParsed.baseline.repository);
  if (
    !token ||
    !apiRoot ||
    !/^\d+$/.test(prNumber ?? "") ||
    !processEnv.PR_HEAD_REF ||
    !processEnv.PR_HEAD_REPO ||
    !processEnv.PR_BASE_REPO ||
    !processEnv.PR_HEAD_SHA ||
    !processEnv.PR_BASE_REF ||
    !processEnv.PR_BASE_SHA
  ) {
    return finish(
      { mode: "FAIL_CLOSED", reason: "gate_metadata_unavailable" },
      { appendOutput, stdoutWrite, processEnv },
    );
  }

  const files = await collectPaginatedItems({
    firstUrl: `${apiRoot}/pulls/${prNumber}/files?per_page=100`,
    token,
    followNext: true,
    perPage: 100,
    itemsFrom: (json) => json,
    fetchImpl,
  });
  if (!files.complete || files.items.some((item) => typeof item?.filename !== "string")) {
    return finish(
      { mode: "FAIL_CLOSED", reason: files.reason ?? "pull_files_invalid" },
      { appendOutput, stdoutWrite, processEnv },
    );
  }

  return finish(
    classifyGate({
      baseline: phase2dParsed.baseline,
      phase2eBaseline: phase2eParsed.baseline,
      changedPaths: files.items.map((item) => item.filename),
      headRef: processEnv.PR_HEAD_REF,
      headSha: processEnv.PR_HEAD_SHA,
      headRepository: processEnv.PR_HEAD_REPO,
      baseRepository: processEnv.PR_BASE_REPO,
      baseRef: processEnv.PR_BASE_REF,
      baseSha: processEnv.PR_BASE_SHA,
      prNumber: processEnv.PR_NUMBER,
    }),
    { appendOutput, stdoutWrite, processEnv },
  );
}

function finish(result, { appendOutput, stdoutWrite, processEnv }) {
  stdoutWrite(
    [
      `trustedPhase2dGateMode=${result.mode}`,
      `reasonCode=${result.reason}`,
      "governanceCandidateAccepted=false",
      "phase2eRuntimeAccepted=false",
      "",
    ].join("\n"),
  );
  if (processEnv.GITHUB_OUTPUT) {
    appendOutput(
      processEnv.GITHUB_OUTPUT,
      `mode=${result.mode}\nreason=${result.reason}\ngovernanceCandidateAccepted=false\nphase2eRuntimeAccepted=false\n`,
    );
  }
  const exitCode = result.mode === "FAIL_CLOSED" ? 1 : 0;
  if (processEnv.TRUSTED_GATE_TEST_NO_EXIT === "1") {
    return { ...result, exitCode };
  }
  process.exit(exitCode);
  return { ...result, exitCode };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTrustedGate().catch(() =>
    finish(
      { mode: "FAIL_CLOSED", reason: "gate_unhandled_error" },
      {
        appendOutput: appendFileSync,
        stdoutWrite: (text) => process.stdout.write(text),
        processEnv: process.env,
      },
    ),
  );
}
