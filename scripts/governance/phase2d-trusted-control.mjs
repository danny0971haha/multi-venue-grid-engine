/**
 * Validate that a checker is running from a clean protected-main descendant
 * and that every trusted governance byte matches the independently generated
 * manifest. This module never reads or executes candidate code.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  GIT_SHA1_RE,
  TRUSTED_BASELINE_PATH,
  pathMatchesAnyRule,
  sha256Bytes,
} from "./phase2d-trusted-freeze-lib.mjs";

export function inspectTrustedCheckout({ repoRoot, baseline }) {
  const reasons = [];
  if (typeof repoRoot !== "string" || !baseline) {
    return { ok: false, reasons: ["trusted_checkout_input_invalid"], headSha: null };
  }

  const status = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) reasons.push("trusted_checkout_status_unavailable");
  else if (status.stdout.length > 0) reasons.push("trusted_checkout_dirty");

  const head = git(repoRoot, ["rev-parse", "HEAD"]);
  const headSha = head.ok ? head.stdout : null;
  if (!GIT_SHA1_RE.test(headSha ?? "")) reasons.push("trusted_checkout_head_invalid");

  const ancestor = gitExit(repoRoot, [
    "merge-base",
    "--is-ancestor",
    baseline.minimumTrustedAncestorSha,
    "HEAD",
  ]);
  if (ancestor === 1) reasons.push("minimum_trusted_ancestor_not_ancestor");
  else if (ancestor !== 0) reasons.push("minimum_trusted_ancestor_check_incomplete");

  const listed = git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]);
  if (!listed.ok) {
    reasons.push("trusted_governance_manifest_unavailable");
  } else {
    const actualPaths = listed.stdout
      .split("\n")
      .filter(Boolean)
      .filter((filePath) => pathMatchesAnyRule(filePath, baseline.trustedGovernancePathRules))
      .sort();
    const expectedPaths = [
      TRUSTED_BASELINE_PATH,
      ...baseline.trustedGovernanceFiles.map((file) => file.path),
    ].sort();
    if (actualPaths.length !== expectedPaths.length) {
      reasons.push("trusted_governance_manifest_path_count_mismatch");
    }
    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(actualPaths);
    if (actualPaths.some((filePath) => !expectedSet.has(filePath))) {
      reasons.push("trusted_governance_manifest_unexpected_path");
    }
    if (expectedPaths.some((filePath) => !actualSet.has(filePath))) {
      reasons.push("trusted_governance_manifest_missing_path");
    }
  }

  for (const expected of baseline.trustedGovernanceFiles) {
    const absolute = path.join(repoRoot, expected.path);
    let bytes;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        reasons.push("trusted_governance_file_type_mismatch");
        continue;
      }
      const mode = stat.mode & 0o111 ? "100755" : "100644";
      if (mode !== expected.mode) reasons.push("trusted_governance_file_mode_mismatch");
      bytes = readFileSync(absolute);
    } catch {
      reasons.push("trusted_governance_file_unreadable");
      continue;
    }
    if (sha256Bytes(bytes) !== expected.sha256) {
      reasons.push("trusted_governance_file_sha256_mismatch");
    }
    const blob = git(repoRoot, ["hash-object", "--stdin"], bytes);
    if (!blob.ok || blob.stdout !== expected.blobSha) {
      reasons.push("trusted_governance_file_blob_mismatch");
    }
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], headSha };
}

function git(repoRoot, args, input) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "ignore"],
      }).trim(),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function gitExit(repoRoot, args) {
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return 0;
  } catch (error) {
    return typeof error?.status === "number" ? error.status : 2;
  }
}
