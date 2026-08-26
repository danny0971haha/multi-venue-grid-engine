import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_TEST_SUITES,
  COMMITMENT_EXACT,
  COMMITMENT_PREFIXES,
  CORRECTIVE4_FOCUSED_TOTAL,
  EVIDENCE_TEST_REL,
  EVIDENCE_VERIFIER_TOTAL,
  EXPECTED_BASE_SHA,
  EXPECTED_FULL_TOTAL,
  IMPLEMENTATION_BASE_SHA,
  PINNED_NODE,
  PINNED_NPM,
  PRIOR_CUMULATIVE_TEST_TOTAL,
  REPOSITORY,
  REQUIRED_COMMANDS,
  REQUIRED_FULL_TEST_GLOBS,
  SCHEMA_ID,
  SOURCE_BRANCH,
  TEST_SUITE_BY_DIR,
} from "../../../scripts/evidence/phase2d-corrective4-schema.mjs";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const zeroAuditPath = path.join(fixtureDir, "zero-audit.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function commandLogName(name) {
  return name.replaceAll(":", "-");
}

/**
 * Independent TAP renderer used only by the handwritten fixture. Not a generator import.
 * @param {number} total
 * @param {number} pass
 * @param {number} fail
 * @param {number} skip
 * @param {number} todo
 * @param {number} cancelled
 */
export function renderTap(total, pass, fail = 0, skip = 0, todo = 0, cancelled = 0) {
  const lines = ["TAP version 13"];
  for (let index = 1; index <= pass; index += 1) {
    lines.push(`ok ${index} - handwritten ${index}`);
  }
  lines.push(`1..${total}`);
  lines.push(`# tests ${total}`);
  lines.push(`# pass ${pass}`);
  lines.push(`# fail ${fail}`);
  lines.push(`# cancelled ${cancelled}`);
  lines.push(`# skipped ${skip}`);
  lines.push(`# todo ${todo}`);
  lines.push("");
  return lines.join("\n");
}

function isCommitmentPath(relativePath) {
  if (COMMITMENT_EXACT.includes(relativePath)) {
    return true;
  }
  return COMMITMENT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function classifyTestSuite(relativePath) {
  if (relativePath === EVIDENCE_TEST_REL) {
    return "evidenceVerifier";
  }
  const directory = relativePath.split("/").slice(0, 2).join("/");
  const suite = TEST_SUITE_BY_DIR[directory];
  if (suite === undefined || !ALLOWED_TEST_SUITES.includes(suite)) {
    throw new Error(`unclassified ${relativePath}`);
  }
  return suite;
}

function listTracked(repositoryRoot) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Assemble an intact schema-v2 artifact without importing the generator library.
 * Identity is forced to local so CI GitHub environment cannot impersonate source HEAD.
 *
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 */
export function assembleHandwrittenIntact(repositoryRoot, artifactRoot) {
  mkdirSync(path.join(artifactRoot, "logs"), { recursive: true });
  const head = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const tree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const baseSha = git(repositoryRoot, ["merge-base", "HEAD", EXPECTED_BASE_SHA]);
  const dryRun = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, RUNTIME_MODE: "DRY_RUN" },
  });
  if (dryRun.status !== 0) {
    throw new Error(`handwritten dry-run failed: ${dryRun.stderr || dryRun.stdout}`);
  }
  const dryRunStdout = dryRun.stdout.split(repositoryRoot).join(".");
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  const zeroAudit = `${readFileSync(zeroAuditPath, "utf8").trim()}\n`;
  const commands = REQUIRED_COMMANDS.map((command) => {
    let stdout = `${command.name} handwritten fixture\n`;
    if (command.name === "test:phase2d-corrective-4") {
      stdout = renderTap(CORRECTIVE4_FOCUSED_TOTAL, CORRECTIVE4_FOCUSED_TOTAL);
    } else if (command.name === "test:evidence:phase2d-corrective4") {
      stdout = renderTap(EVIDENCE_VERIFIER_TOTAL, EVIDENCE_VERIFIER_TOTAL);
    } else if (command.name === "test") {
      stdout = renderTap(EXPECTED_FULL_TOTAL, EXPECTED_FULL_TOTAL);
    } else if (command.name === "dry-run") {
      stdout = dryRunStdout;
    } else if (command.name === "audit") {
      stdout = zeroAudit;
    }
    const stderr = "";
    const stdoutFile = `logs/${commandLogName(command.name)}.stdout.log`;
    const stderrFile = `logs/${commandLogName(command.name)}.stderr.log`;
    writeFileSync(path.join(artifactRoot, stdoutFile), stdout);
    writeFileSync(path.join(artifactRoot, stderrFile), stderr);
    return {
      name: command.name,
      argv: [...command.argv],
      exitCode: 0,
      stdoutFile,
      stderrFile,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      startedAt,
      completedAt,
    };
  });

  const tracked = listTracked(repositoryRoot);
  const commitmentFiles = tracked
    .filter(isCommitmentPath)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((relativePath) => ({
      path: relativePath,
      sha256: sha256(readFileSync(path.join(repositoryRoot, relativePath))),
    }));
  const inventoryFiles = tracked
    .filter((relativePath) => {
      const parts = relativePath.split("/");
      if (parts.length !== 3 || parts[0] !== "test" || !relativePath.endsWith(".test.ts")) {
        return false;
      }
      return REQUIRED_FULL_TEST_GLOBS.includes(`test/${parts[1]}/*.test.ts`);
    })
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((relativePath) => ({
      path: relativePath,
      sha256: sha256(readFileSync(path.join(repositoryRoot, relativePath))),
      suite: classifyTestSuite(relativePath),
    }));

  const fileCommitment = { files: commitmentFiles };
  const testFileInventory = { files: inventoryFiles };
  const auditFacts = {
    auditReportVersion: 2,
    metadataCounts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    observedRowCounts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    metadataMatchesRows: true,
    vulnerabilityKeys: [],
    auditZero: true,
  };
  const counts = (total) => ({
    total,
    pass: total,
    fail: 0,
    skip: 0,
    todo: 0,
    cancelled: 0,
  });

  const manifest = {
    schema: SCHEMA_ID,
    identity: {
      repository: REPOSITORY,
      sourceBranch: SOURCE_BRANCH,
      sourceHeadSha: head,
      sourceHeadTreeSha: tree,
      testedCheckoutSha: head,
      testedCheckoutTreeSha: tree,
      baseSha,
      implementationBaseSha: IMPLEMENTATION_BASE_SHA,
      githubEventName: "local",
      githubRunId: "local",
      githubRunAttempt: "local",
      githubJob: "local",
      generatedAt: startedAt,
    },
    toolchain: {
      nodeVersion: process.version,
      npmVersion: PINNED_NPM,
      operatingSystem: os.type(),
      architecture: process.arch,
    },
    commands,
    testFacts: {
      priorCumulativeTestTotal: PRIOR_CUMULATIVE_TEST_TOTAL,
      corrective4: counts(CORRECTIVE4_FOCUSED_TOTAL),
      evidenceVerifier: counts(EVIDENCE_VERIFIER_TOTAL),
      full: counts(EXPECTED_FULL_TOTAL),
    },
    auditFacts,
    safety: {
      systemAllowRiskIncrease: false,
      liveExchangeWrite: false,
      productionCredentialUsed: false,
      testnetTradingKeyUsed: false,
      mergePerformed: false,
      deployPerformed: false,
      phase2EStarted: false,
    },
    fileCommitment,
    testFileInventory,
  };

  if (process.version !== PINNED_NODE) {
    throw new Error(`handwritten fixture requires ${PINNED_NODE}`);
  }
  if (!existsSync(path.join(repositoryRoot, "package.json"))) {
    throw new Error("package.json missing");
  }

  writeFileSync(path.join(artifactRoot, "audit.json"), zeroAudit);
  writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(artifactRoot, "file-hashes.json"),
    `${JSON.stringify(fileCommitment, null, 2)}\n`,
  );
  return manifest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const artifactRoot = process.argv[2];
  if (artifactRoot === undefined) {
    process.stderr.write("usage: handwritten-intact.mjs <artifact-dir>\n");
    process.exitCode = 1;
  } else {
    const repositoryRoot = path.resolve(fixtureDir, "../../..");
    assembleHandwrittenIntact(repositoryRoot, path.resolve(artifactRoot));
    process.stdout.write(`handwritten intact fixture written to ${artifactRoot}\n`);
  }
}
