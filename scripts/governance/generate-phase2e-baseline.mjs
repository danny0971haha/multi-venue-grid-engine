#!/usr/bin/env node
/**
 * Generate the trusted Phase 2E baseline from Git objects at the bound
 * Runtime Corrective 1 HEAD stacked on the frozen Phase 2D candidate.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathMatchesAnyRule, sha256Bytes } from "./phase2d-trusted-freeze-lib.mjs";
import {
  PHASE2E_SCHEMA_VERSION,
  PHASE2E_TRUSTED_BASELINE_PATH,
  PHASE2E_FROZEN_BASE_SHA,
  PHASE2E_CANDIDATE_HEAD_SHA,
  PHASE2E_CANDIDATE_HEAD_REF,
  PHASE2E_CANDIDATE_BASE_REF,
  PHASE2E_REPOSITORY,
  PHASE2E_PROTECTED_PATH_RULES,
  PHASE2E_TRUSTED_GOVERNANCE_PATH_RULES,
  PHASE2E_REQUIRED_RUNTIME_COMMANDS,
  PHASE2E_FORBIDDEN_RUNTIME_COMMANDS,
} from "./phase2e-trusted-freeze-lib.mjs";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: options.cwd ?? repoRoot(),
    input: options.input,
  }).trim();
}

function gitBytes(args) {
  return execFileSync("git", args, { cwd: repoRoot() });
}

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function treeIndex(ref) {
  const result = new Map();
  const output = execFileSync("git", ["ls-tree", "-r", "-z", ref], { cwd: repoRoot() });
  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error("ls_tree_malformed");
    const [mode, objectType, blobSha] = record.slice(0, tab).split(" ");
    const filePath = record.slice(tab + 1);
    if (objectType !== "blob") throw new Error(`non_blob:${filePath}:${objectType}`);
    result.set(filePath, { mode, objectType, blobSha });
  }
  return result;
}

function snapshotWithHash(snapshot) {
  return {
    ...snapshot,
    sha256: sha256Bytes(gitBytes(["cat-file", "blob", snapshot.blobSha])),
  };
}

function parsePackageJson(ref) {
  return JSON.parse(git(["show", `${ref}:package.json`]));
}

function main() {
  const baseSha = git(["rev-parse", PHASE2E_FROZEN_BASE_SHA]);
  const headSha = git(["rev-parse", PHASE2E_CANDIDATE_HEAD_SHA]);
  if (baseSha !== PHASE2E_FROZEN_BASE_SHA || headSha !== PHASE2E_CANDIDATE_HEAD_SHA) {
    throw new Error("git_rev_parse_mismatch");
  }
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", PHASE2E_FROZEN_BASE_SHA, PHASE2E_CANDIDATE_HEAD_SHA],
      {
        cwd: repoRoot(),
        stdio: "ignore",
      },
    );
  } catch {
    throw new Error("frozen_base_not_ancestor");
  }

  const frozenBaseTreeSha = git(["rev-parse", `${PHASE2E_FROZEN_BASE_SHA}^{tree}`]);
  const candidateHeadTreeSha = git(["rev-parse", `${PHASE2E_CANDIDATE_HEAD_SHA}^{tree}`]);
  const baseIndex = treeIndex(PHASE2E_FROZEN_BASE_SHA);
  const headIndex = treeIndex(PHASE2E_CANDIDATE_HEAD_SHA);

  const candidateChangedFiles = [];
  for (const filePath of [...new Set([...baseIndex.keys(), ...headIndex.keys()])].sort()) {
    const base = baseIndex.get(filePath) ?? null;
    const head = headIndex.get(filePath) ?? null;
    if (
      base &&
      head &&
      base.mode === head.mode &&
      base.objectType === head.objectType &&
      base.blobSha === head.blobSha
    ) {
      continue;
    }
    candidateChangedFiles.push({
      path: filePath,
      change: base === null ? "added" : head === null ? "deleted" : "modified",
      base: base ? snapshotWithHash(base) : null,
      head: head ? snapshotWithHash(head) : null,
    });
  }

  const allowedChangedPaths = candidateChangedFiles.map((item) => item.path);
  const protectedFrozenFiles = [];
  for (const [filePath, snapshot] of [...baseIndex.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (!pathMatchesAnyRule(filePath, PHASE2E_PROTECTED_PATH_RULES)) continue;
    if (allowedChangedPaths.includes(filePath)) {
      throw new Error(`protected_path_in_phase2e_inventory:${filePath}`);
    }
    const head = headIndex.get(filePath);
    if (!head || head.blobSha !== snapshot.blobSha || head.mode !== snapshot.mode) {
      throw new Error(`protected_frozen_bytes_changed:${filePath}`);
    }
    protectedFrozenFiles.push({
      path: filePath,
      ...snapshotWithHash(snapshot),
    });
  }

  const lock = snapshotWithHash(baseIndex.get("package-lock.json"));
  const headLock = headIndex.get("package-lock.json");
  if (!headLock || headLock.blobSha !== lock.blobSha) {
    throw new Error("package_lock_changed");
  }

  const basePkg = parsePackageJson(PHASE2E_FROZEN_BASE_SHA);
  const headPkg = parsePackageJson(PHASE2E_CANDIDATE_HEAD_SHA);
  const allowedScriptKeysChanged = Object.keys(headPkg.scripts)
    .filter((key) => basePkg.scripts[key] !== headPkg.scripts[key])
    .concat(Object.keys(basePkg.scripts).filter((key) => !(key in headPkg.scripts)))
    .filter((key, index, all) => all.indexOf(key) === index)
    .sort();

  const manifest = {
    schemaVersion: PHASE2E_SCHEMA_VERSION,
    repository: PHASE2E_REPOSITORY,
    candidateHeadRef: PHASE2E_CANDIDATE_HEAD_REF,
    candidateBaseRef: PHASE2E_CANDIDATE_BASE_REF,
    frozenBaseSha: PHASE2E_FROZEN_BASE_SHA,
    frozenBaseTreeSha,
    candidateHeadSha: PHASE2E_CANDIDATE_HEAD_SHA,
    candidateHeadTreeSha,
    allowedChangedPaths,
    candidateChangedFiles,
    protectedPathRules: PHASE2E_PROTECTED_PATH_RULES,
    protectedFrozenFiles,
    trustedGovernancePathRules: PHASE2E_TRUSTED_GOVERNANCE_PATH_RULES,
    packageLock: {
      path: "package-lock.json",
      ...lock,
    },
    dependencyIdentity: {
      dependencies: headPkg.dependencies,
      devDependencies: headPkg.devDependencies,
    },
    packageJsonScriptsPolicy: {
      allowedScriptKeysChanged,
      expectedBaseTestScript: basePkg.scripts.test,
      expectedHeadScripts: Object.fromEntries(
        allowedScriptKeysChanged.map((key) => [key, headPkg.scripts[key] ?? null]),
      ),
    },
    requiredNodeVersion: "v22.23.2",
    requiredNpmVersion: "10.9.8",
    requiredRuntimeCommands: PHASE2E_REQUIRED_RUNTIME_COMMANDS,
    forbiddenRuntimeCommands: PHASE2E_FORBIDDEN_RUNTIME_COMMANDS,
    npmTestIgnoredTapFileSuffix: "test/evidence/phase2d-corrective4-evidence.test.ts",
  };

  const outPath = path.join(repoRoot(), PHASE2E_TRUSTED_BASELINE_PATH);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `wrote ${PHASE2E_TRUSTED_BASELINE_PATH} changed=${candidateChangedFiles.length} protected=${protectedFrozenFiles.length} tree=${candidateHeadTreeSha}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
