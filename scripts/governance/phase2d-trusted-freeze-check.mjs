#!/usr/bin/env node
/**
 * Trusted freeze CLI. Intended to run from a protected-main checkout only.
 * Reads GitHub metadata from environment variables. Does not checkout PR code.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseBaseline,
  evaluateTrustedFreeze,
  formatMachineSummary,
  summaryContainsForbiddenDecisionWording,
  TRUSTED_BASELINE_PATH,
} from "./phase2d-trusted-freeze-lib.mjs";
import {
  fetchBlobUtf8,
  fetchCommitTreeSha,
  fetchCompareAncestor,
  fetchRecursiveTree,
} from "./phase2d-trusted-freeze-github.mjs";

const DEFAULT_API = "https://api.github.com";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");
  const baselinePath = path.join(repoRoot, TRUSTED_BASELINE_PATH);
  let jsonText;
  try {
    jsonText = readFileSync(baselinePath, "utf8");
  } catch {
    return failClosed({
      trustedBaselineIntegrityOk: false,
      sourceHeadMatchesReviewedCandidate: false,
      reasons: ["baseline_unreadable"],
    });
  }

  const parsed = parseBaseline(jsonText);
  if (!parsed.ok) {
    return failClosed({
      trustedBaselineIntegrityOk: false,
      sourceHeadMatchesReviewedCandidate: false,
      reasons: parsed.reasons,
    });
  }

  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || DEFAULT_API;
  const sourceHeadSha = process.env.PR_HEAD_SHA;
  const eventSourceHeadSha = process.env.PR_HEAD_SHA;
  const repositoryFullName = process.env.PR_BASE_REPO;
  const prHeadRepositoryFullName = process.env.PR_HEAD_REPO;

  if (!token) {
    return failClosed(evaluateTrustedFreeze({
      baseline: parsed.baseline,
      repositoryFullName,
      prHeadRepositoryFullName,
      sourceHeadSha,
      eventSourceHeadSha,
      ancestorCheckComplete: false,
      implementationBaseIsAncestor: false,
      baseTreeComplete: false,
      headTreeComplete: false,
      baseTree: [],
      headTree: [],
    }));
  }

  const baseCommit = await fetchCommitTreeSha({
    apiUrl,
    repository: parsed.baseline.repository,
    commitSha: parsed.baseline.acceptedImplementationBaseSha,
    token,
  });
  const headCommit = await fetchCommitTreeSha({
    apiUrl,
    repository: parsed.baseline.repository,
    commitSha: sourceHeadSha,
    token,
  });
  const baseTree = baseCommit.complete
    ? await fetchRecursiveTree({
        apiUrl,
        repository: parsed.baseline.repository,
        treeSha: baseCommit.treeSha,
        token,
      })
    : { complete: false, reason: baseCommit.reason, entries: [] };
  const headTree = headCommit.complete
    ? await fetchRecursiveTree({
        apiUrl,
        repository: parsed.baseline.repository,
        treeSha: headCommit.treeSha,
        token,
      })
    : { complete: false, reason: headCommit.reason, entries: [] };
  const compare = await fetchCompareAncestor({
    apiUrl,
    repository: parsed.baseline.repository,
    baseSha: parsed.baseline.acceptedImplementationBaseSha,
    headSha: sourceHeadSha,
    token,
  });

  const headTextByPath = {};
  let anchorContentComplete = true;
  if (headTree.complete) {
    for (const anchor of parsed.baseline.protectedContentAnchors) {
      const entry = headTree.entries.find((item) => item.path === anchor.path);
      if (!entry) {
        anchorContentComplete = false;
        continue;
      }
      const blob = await fetchBlobUtf8({
        apiUrl,
        repository: parsed.baseline.repository,
        blobSha: entry.sha,
        token,
      });
      if (!blob.complete) {
        anchorContentComplete = false;
        continue;
      }
      headTextByPath[anchor.path] = blob.text;
    }
  } else {
    anchorContentComplete = false;
  }

  const extraReasons = [];
  if (!baseCommit.complete) extraReasons.push(baseCommit.reason ?? "base_commit_incomplete");
  if (!headCommit.complete) extraReasons.push(headCommit.reason ?? "head_commit_incomplete");
  if (!baseTree.complete) extraReasons.push(baseTree.reason ?? "base_tree_incomplete");
  if (!headTree.complete) extraReasons.push(headTree.reason ?? "head_tree_incomplete");
  if (!compare.complete) extraReasons.push(compare.reason ?? "ancestor_check_incomplete");
  if (!anchorContentComplete) extraReasons.push("anchor_content_unavailable");

  const evaluation = evaluateTrustedFreeze({
    baseline: parsed.baseline,
    repositoryFullName,
    prHeadRepositoryFullName,
    sourceHeadSha,
    eventSourceHeadSha,
    ancestorCheckComplete: compare.complete === true,
    implementationBaseIsAncestor: compare.isAncestor === true,
    baseTreeComplete: baseTree.complete === true,
    headTreeComplete: headTree.complete === true,
    observedBaseTreeSha: baseCommit.treeSha,
    baseTree: baseTree.entries ?? [],
    headTree: headTree.entries ?? [],
    compareFiles: compare.files,
    compareFilesIncomplete: compare.reason === "compare_files_unpaginated_limit",
    headTextByPath,
  });
  evaluation.reasons = [...new Set([...extraReasons, ...evaluation.reasons])];
  if (extraReasons.length > 0) {
    evaluation.trustedBaselineIntegrityOk = false;
  }
  return finish(evaluation);
}

function failClosed(evaluation) {
  return finish({
    trustedBaselineIntegrityOk: false,
    sourceHeadMatchesReviewedCandidate: Boolean(
      evaluation.sourceHeadMatchesReviewedCandidate,
    ),
    reasons: evaluation.reasons ?? ["fail_closed"],
  });
}

function finish(evaluation) {
  const text = formatMachineSummary(evaluation);
  if (summaryContainsForbiddenDecisionWording(text)) {
    evaluation.trustedBaselineIntegrityOk = false;
    evaluation.reasons = [...evaluation.reasons, "forbidden_decision_wording"];
  }
  const output = formatMachineSummary(evaluation);
  process.stdout.write(`${output}\n`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `trustedBaselineIntegrityOk=${evaluation.trustedBaselineIntegrityOk ? "true" : "false"}\n`,
    );
    appendFileSync(
      githubOutput,
      `sourceHeadMatchesReviewedCandidate=${evaluation.sourceHeadMatchesReviewedCandidate ? "true" : "false"}\n`,
    );
  }
  const ok =
    evaluation.trustedBaselineIntegrityOk &&
    evaluation.sourceHeadMatchesReviewedCandidate;
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "unknown_error";
  finish({
    trustedBaselineIntegrityOk: false,
    sourceHeadMatchesReviewedCandidate: false,
    reasons: ["checker_unhandled_error"],
    // Keep the original error off the machine summary so PR-controlled
    // text cannot land in shell-interpolated logs.
    _ignored: message,
  });
});
