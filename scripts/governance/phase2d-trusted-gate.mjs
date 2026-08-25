#!/usr/bin/env node
/** Stable always-run required context classifier for pull requests targeting main. */

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  TRUSTED_BASELINE_PATH,
  parseBaseline,
  pathMatchesAnyRule,
} from "./phase2d-trusted-freeze-lib.mjs";
import { collectPaginatedItems, repoApiRoot } from "./phase2d-trusted-freeze-github.mjs";

export function classifyGate({ baseline, changedPaths, headRef, headRepository, baseRepository }) {
  if (!baseline || !Array.isArray(changedPaths) || baseRepository !== baseline?.repository) {
    return { mode: "FAIL_CLOSED", reason: "gate_input_invalid" };
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
    return { mode: "ENFORCE", reason: "phase2_and_trusted_paths_touched" };
  }
  if (headRef === baseline.candidateHeadRef || phase2Touched) {
    return { mode: "ENFORCE", reason: "phase2_candidate_or_path_touched" };
  }
  if (trustedTouched) {
    if (headRepository !== baseline.repository) {
      return { mode: "FAIL_CLOSED", reason: "fork_trusted_governance_change" };
    }
    return { mode: "GOVERNANCE_REVIEW_REQUIRED", reason: "trusted_governance_path_touched" };
  }
  return { mode: "NOT_APPLICABLE", reason: "phase2_paths_not_touched" };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..");
  const parsed = parseBaseline(readFileSync(path.join(root, TRUSTED_BASELINE_PATH), "utf8"));
  if (!parsed.ok) return finish({ mode: "FAIL_CLOSED", reason: parsed.reasons.join(",") });
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
  const prNumber = process.env.PR_NUMBER;
  const apiRoot = repoApiRoot(apiUrl, parsed.baseline.repository);
  if (!token || !apiRoot || !/^\d+$/.test(prNumber ?? "")) {
    return finish({ mode: "FAIL_CLOSED", reason: "gate_metadata_unavailable" });
  }
  const files = await collectPaginatedItems({
    firstUrl: `${apiRoot}/pulls/${prNumber}/files?per_page=100`,
    token,
    followNext: true,
    perPage: 100,
    itemsFrom: (json) => json,
  });
  if (!files.complete || files.items.some((item) => typeof item?.filename !== "string")) {
    return finish({ mode: "FAIL_CLOSED", reason: files.reason ?? "pull_files_invalid" });
  }
  return finish(classifyGate({
    baseline: parsed.baseline,
    changedPaths: files.items.map((item) => item.filename),
    headRef: process.env.PR_HEAD_REF,
    headRepository: process.env.PR_HEAD_REPO,
    baseRepository: process.env.PR_BASE_REPO,
  }));
}

function finish(result) {
  process.stdout.write(`trustedPhase2dGateMode=${result.mode}\nreasonCode=${result.reason}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${result.mode}\nreason=${result.reason}\n`);
  }
  process.exit(result.mode === "FAIL_CLOSED" ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => finish({ mode: "FAIL_CLOSED", reason: "gate_unhandled_error" }));
}
