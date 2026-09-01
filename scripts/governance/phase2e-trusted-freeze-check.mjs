#!/usr/bin/env node
/**
 * Trusted Phase 2E integrity CLI. Runs from the trusted workflow checkout only.
 * Uses GitHub Git APIs. Does not checkout or execute candidate code.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  parseBaseline,
  sha256Bytes,
  TRUSTED_BASELINE_PATH,
} from "./phase2d-trusted-freeze-lib.mjs";
import { inspectTrustedCheckout } from "./phase2d-trusted-control.mjs";
import {
  fetchBlobBytes,
  fetchBlobUtf8,
  fetchCommitTreeSha,
  fetchCompareAncestor,
  fetchRecursiveTree,
} from "./phase2d-trusted-freeze-github.mjs";
import {
  PHASE2E_TRUSTED_BASELINE_PATH,
  evaluatePhase2eIntegrity,
  formatPhase2eMachineSummary,
  parsePhase2eBaseline,
} from "./phase2e-trusted-freeze-lib.mjs";
import { summaryContainsForbiddenDecisionWording } from "./phase2d-trusted-freeze-lib.mjs";

const DEFAULT_API = "https://api.github.com";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", "..");

  let phase2dJson;
  let phase2eJson;
  try {
    phase2dJson = readFileSync(path.join(repoRoot, TRUSTED_BASELINE_PATH), "utf8");
    phase2eJson = readFileSync(path.join(repoRoot, PHASE2E_TRUSTED_BASELINE_PATH), "utf8");
  } catch {
    return failClosed({ reasons: ["baseline_unreadable"] });
  }

  const phase2d = parseBaseline(phase2dJson);
  const phase2e = parsePhase2eBaseline(phase2eJson);
  if (!phase2d.ok) return failClosed({ reasons: phase2d.reasons });
  if (!phase2e.ok) return failClosed({ reasons: phase2e.reasons });

  const trustedCheckout = inspectTrustedCheckout({
    repoRoot,
    baseline: phase2d.baseline,
    expectedHeadSha: process.env.TRUSTED_WORKFLOW_SHA,
  });
  if (!trustedCheckout.ok) {
    return failClosed({ reasons: trustedCheckout.reasons });
  }

  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL || DEFAULT_API;
  const sourceHeadSha = process.env.PR_HEAD_SHA;
  const eventSourceHeadSha = process.env.PR_HEAD_SHA;
  const repositoryFullName = process.env.PR_BASE_REPO;
  const prHeadRepositoryFullName = process.env.PR_HEAD_REPO;
  const prHeadRef = process.env.PR_HEAD_REF;
  const prBaseRef = process.env.PR_BASE_REF;
  const prBaseSha = process.env.PR_BASE_SHA;
  const prNumber = process.env.PR_NUMBER;
  const baseline = phase2e.baseline;

  if (!token) {
    return failClosed(
      evaluatePhase2eIntegrity({
        baseline,
        repositoryFullName,
        prHeadRepositoryFullName,
        prHeadRef,
        prBaseRef,
        prBaseSha,
        prNumber,
        sourceHeadSha,
        eventSourceHeadSha,
        ancestorCheckComplete: false,
        frozenBaseIsAncestor: false,
        baseTreeComplete: false,
        headTreeComplete: false,
        baseTree: [],
        headTree: [],
      }),
    );
  }

  const baseCommit = await fetchCommitTreeSha({
    apiUrl,
    repository: baseline.repository,
    commitSha: baseline.frozenBaseSha,
    token,
  });
  const headCommit = await fetchCommitTreeSha({
    apiUrl,
    repository: baseline.repository,
    commitSha: sourceHeadSha,
    token,
  });
  const baseTree = baseCommit.complete
    ? await fetchRecursiveTree({
        apiUrl,
        repository: baseline.repository,
        treeSha: baseCommit.treeSha,
        token,
      })
    : { complete: false, reason: baseCommit.reason, entries: [] };
  const headTree = headCommit.complete
    ? await fetchRecursiveTree({
        apiUrl,
        repository: baseline.repository,
        treeSha: headCommit.treeSha,
        token,
      })
    : { complete: false, reason: headCommit.reason, entries: [] };
  const compare = await fetchCompareAncestor({
    apiUrl,
    repository: baseline.repository,
    baseSha: baseline.frozenBaseSha,
    headSha: sourceHeadSha,
    token,
  });

  const headTextByPath = {};
  let packageJsonComplete = true;
  if (headTree.complete) {
    const pkg = headTree.entries.find((item) => item.path === "package.json");
    if (!pkg) {
      packageJsonComplete = false;
    } else {
      const blob = await fetchBlobUtf8({
        apiUrl,
        repository: baseline.repository,
        blobSha: pkg.sha,
        token,
      });
      if (!blob.complete) packageJsonComplete = false;
      else headTextByPath["package.json"] = blob.text;
    }
  } else {
    packageJsonComplete = false;
  }

  const observedBlobSha256ByKey = {};
  let blobHashesComplete = true;
  if (baseTree.complete && headTree.complete) {
    const requests = new Map();
    for (const file of baseline.protectedFrozenFiles) {
      requests.set(`head:${file.path}`, file.blobSha);
    }
    for (const item of baseline.candidateChangedFiles) {
      if (item.base) requests.set(`base:${item.path}`, item.base.blobSha);
      if (item.head) requests.set(`head:${item.path}`, item.head.blobSha);
    }
    requests.set("head:package-lock.json", baseline.packageLock.blobSha);
    const cache = new Map();
    for (const [key, blobSha] of requests) {
      let promise = cache.get(blobSha);
      if (!promise) {
        promise = fetchBlobBytes({
          apiUrl,
          repository: baseline.repository,
          blobSha,
          token,
        });
        cache.set(blobSha, promise);
      }
      const blob = await promise;
      if (!blob.complete) {
        blobHashesComplete = false;
        continue;
      }
      observedBlobSha256ByKey[key] = sha256Bytes(blob.bytes);
    }
  } else {
    blobHashesComplete = false;
  }

  const extraReasons = [];
  if (!baseCommit.complete) extraReasons.push(baseCommit.reason ?? "base_commit_incomplete");
  if (!headCommit.complete) extraReasons.push(headCommit.reason ?? "head_commit_incomplete");
  if (!baseTree.complete) extraReasons.push(baseTree.reason ?? "base_tree_incomplete");
  if (!headTree.complete) extraReasons.push(headTree.reason ?? "head_tree_incomplete");
  if (!compare.complete) extraReasons.push(compare.reason ?? "ancestor_check_incomplete");
  if (!packageJsonComplete) extraReasons.push("package_json_unavailable");
  if (!blobHashesComplete) extraReasons.push("blob_sha256_unavailable");

  const evaluation = evaluatePhase2eIntegrity({
    baseline,
    repositoryFullName,
    prHeadRepositoryFullName,
    prHeadRef,
    prBaseRef,
    prBaseSha,
    prNumber,
    sourceHeadSha,
    eventSourceHeadSha,
    ancestorCheckComplete: compare.complete === true,
    frozenBaseIsAncestor: compare.isAncestor === true,
    baseTreeComplete: baseTree.complete === true,
    headTreeComplete: headTree.complete === true,
    observedBaseTreeSha: baseCommit.treeSha,
    observedHeadTreeSha: headCommit.treeSha,
    baseTree: baseTree.entries ?? [],
    headTree: headTree.entries ?? [],
    compareFiles: compare.files,
    compareFilesIncomplete: compare.reason === "compare_files_unpaginated_limit",
    headTextByPath,
    observedBlobSha256ByKey,
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
    sourceHeadMatchesReviewedCandidate: Boolean(evaluation.sourceHeadMatchesReviewedCandidate),
    reasons: evaluation.reasons ?? ["fail_closed"],
  });
}

function finish(evaluation) {
  if (summaryContainsForbiddenDecisionWording(formatPhase2eMachineSummary(evaluation))) {
    evaluation.trustedBaselineIntegrityOk = false;
    evaluation.reasons = [...evaluation.reasons, "forbidden_decision_wording"];
  }
  const output = formatPhase2eMachineSummary(evaluation);
  process.stdout.write(`${output}\n`);
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `phase2eTrustedBaselineIntegrityOk=${evaluation.trustedBaselineIntegrityOk ? "true" : "false"}\n`,
    );
    appendFileSync(
      githubOutput,
      `sourceHeadMatchesReviewedCandidate=${evaluation.sourceHeadMatchesReviewedCandidate ? "true" : "false"}\n`,
    );
  }
  const ok = evaluation.trustedBaselineIntegrityOk && evaluation.sourceHeadMatchesReviewedCandidate;
  process.exit(ok ? 0 : 1);
}

main().catch(() => {
  finish({
    trustedBaselineIntegrityOk: false,
    sourceHeadMatchesReviewedCandidate: false,
    reasons: ["checker_unhandled_error"],
  });
});
