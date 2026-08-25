import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALLOWED_TEST_SUITES,
  ARTIFACT_DIR_REL,
  AUDIT_COUNT_KEYS,
  COMMITMENT_EXACT,
  COMMITMENT_PREFIXES,
  CORRECTIVE4_FOCUSED_TOTAL,
  CORRECTIVE4_TEST_REL,
  EVIDENCE_TEST_REL,
  EVIDENCE_VERIFIER_TOTAL,
  EXPECTED_BASE_SHA,
  EXPECTED_FULL_TOTAL,
  EvidenceError,
  IMPLEMENTATION_BASE_SHA,
  PINNED_NODE,
  PINNED_NPM,
  PRIOR_CUMULATIVE_TEST_TOTAL,
  REPOSITORY,
  REQUIRED_COMMANDS,
  REQUIRED_FULL_TEST_GLOBS,
  SAFETY_KEYS,
  SCHEMA_ID,
  TEST_SUITE_BY_DIR,
} from "./phase2d-corrective4-schema.mjs";

const NETWORK_IMPORT =
  /from ["'](?:node:(?:http|https|net|dns|tls|dgram|undici)|https?|net|undici|ws|axios|websocket)["']/;

const SECRET_CONTENT_PATTERNS = [
  { id: "private-key-material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { id: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  {
    id: "api-secret-fixture",
    pattern: /(?:bearer|api[_-]?secret|api[_-]?key)\s*[:=]\s*['"][^'"]{16,}['"]/i,
  },
];

const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s:(["'`])(?:\/(?:Users|home|opt|usr|var|private|tmp|workspace|root)\/|[A-Za-z]:\\)/;

const PRODUCTION_CREDENTIAL_ENV = [
  /^EXCHANGE_/,
  /^BINANCE_/,
  /^BYBIT_/,
  /^OKX_/,
  /^GATEIO_/,
  /^(?:API_SECRET|TRADING_API_KEY)$/,
  /TRADING_KEY/,
  /WITHDRAWAL/,
];

const TESTNET_CREDENTIAL_ENV = [/TESTNET/, /TEST_NET/];

const GATE_VERDICT_TEXT = [
  /"PHASE_2D_CORRECTIVE_4"\s*:\s*"(PASS|ACCEPT)"/,
  /"PHASE_2D_CORRECTIVE_4_EVIDENCE"\s*:\s*"(PASS|ACCEPT)"/,
  /"GATE_2"\s*:\s*"PASS"/,
  /"PHASE_2D"\s*:\s*"PASS"/,
  /"verdict"\s*:\s*"(PASS|ACCEPT)"/,
  /"requestedVerdict"\s*:/,
  /"requestedDecision"\s*:/,
  /"selfDeclaredPass"\s*:/,
];

/**
 * @param {string} repositoryRoot
 */
export function artifactDir(repositoryRoot) {
  return path.join(repositoryRoot, ARTIFACT_DIR_REL);
}

/**
 * @param {Buffer | string} value
 */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} filePath
 */
export function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

/**
 * Generator TAP parser (last-wins). Intentionally not shared with the verifier.
 * @param {string} text
 */
export function parseTapSummary(text) {
  let tests;
  let pass;
  let fail = 0;
  let cancelled = 0;
  let skipped = 0;
  let todo = 0;
  let sawSummary = false;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }
    const testsMatch = /^# tests (\d+)\s*$/.exec(line);
    if (testsMatch) {
      tests = Number(testsMatch[1]);
      sawSummary = true;
      continue;
    }
    const passMatch = /^# pass (\d+)\s*$/.exec(line);
    if (passMatch) {
      pass = Number(passMatch[1]);
      continue;
    }
    const failMatch = /^# fail (\d+)\s*$/.exec(line);
    if (failMatch) {
      fail = Number(failMatch[1]);
      continue;
    }
    const cancelledMatch = /^# cancelled (\d+)\s*$/.exec(line);
    if (cancelledMatch) {
      cancelled = Number(cancelledMatch[1]);
      continue;
    }
    const skippedMatch = /^# skipped (\d+)\s*$/.exec(line);
    if (skippedMatch) {
      skipped = Number(skippedMatch[1]);
      continue;
    }
    const todoMatch = /^# todo (\d+)\s*$/.exec(line);
    if (todoMatch) {
      todo = Number(todoMatch[1]);
    }
  }

  if (!sawSummary || tests === undefined || pass === undefined || Number.isNaN(tests)) {
    throw new EvidenceError("TAP", "TAP summary comments are missing");
  }

  return {
    total: tests,
    pass,
    fail,
    skip: skipped,
    todo,
    cancelled,
  };
}

/**
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
    lines.push(`ok ${index} - synthetic ${index}`);
  }
  for (let index = 1; index <= fail; index += 1) {
    lines.push(`not ok ${pass + index} - synthetic fail ${index}`);
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

/**
 * @param {string} repositoryRoot
 * @param {readonly string[]} args
 */
export function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

/**
 * @param {string} repositoryRoot
 */
export function listTrackedFiles(repositoryRoot) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const files = output.split("\0").filter(Boolean);
  for (const relativePath of files) {
    assertSafeRelativePath(relativePath);
  }
  return files;
}

/**
 * @param {string} relativePath
 */
export function assertSafeRelativePath(relativePath) {
  if (relativePath.trim() !== relativePath) {
    throw new EvidenceError("PATH", `path has surrounding whitespace: ${relativePath}`);
  }
  if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes(":")) {
    throw new EvidenceError("PATH", `absolute or drive path is not allowed: ${relativePath}`);
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new EvidenceError("PATH", `path traversal or empty segment: ${relativePath}`);
  }
}

/**
 * @param {string} relativePath
 */
export function isCommitmentPath(relativePath) {
  if (COMMITMENT_EXACT.includes(relativePath)) {
    return true;
  }
  return COMMITMENT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * @param {string} repositoryRoot
 */
export function collectFileCommitment(repositoryRoot) {
  const matched = listTrackedFiles(repositoryRoot).filter(isCommitmentPath);
  const unique = new Set(matched);
  if (unique.size !== matched.length) {
    throw new EvidenceError("PATH", "duplicate commitment path");
  }
  const sorted = [...matched].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sorted.length === 0) {
    throw new EvidenceError("PATH", "commitment file list is empty");
  }
  return {
    files: sorted.map((relativePath) => ({
      path: relativePath,
      sha256: sha256File(path.join(repositoryRoot, relativePath)),
    })),
  };
}

function classifyTestSuite(relativePath) {
  if (relativePath === EVIDENCE_TEST_REL) {
    return "evidenceVerifier";
  }
  const directory = relativePath.split("/").slice(0, 2).join("/");
  const suite = TEST_SUITE_BY_DIR[directory];
  if (suite === undefined || !ALLOWED_TEST_SUITES.includes(suite)) {
    throw new EvidenceError("INVENTORY", `unclassified test file ${relativePath}`);
  }
  return suite;
}

/**
 * Generator-owned inventory scan. Not imported by the verifier.
 * @param {string} repositoryRoot
 */
export function collectTestFileInventory(repositoryRoot) {
  const tracked = listTrackedFiles(repositoryRoot);
  const files = [];
  for (const relativePath of tracked) {
    const parts = relativePath.split("/");
    if (parts.length !== 3 || parts[0] !== "test" || !relativePath.endsWith(".test.ts")) {
      continue;
    }
    const glob = `test/${parts[1]}/*.test.ts`;
    if (!REQUIRED_FULL_TEST_GLOBS.includes(glob)) {
      continue;
    }
    files.push({
      path: relativePath,
      sha256: sha256File(path.join(repositoryRoot, relativePath)),
      suite: classifyTestSuite(relativePath),
    });
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (!files.some((entry) => entry.path === EVIDENCE_TEST_REL)) {
    throw new EvidenceError("INVENTORY", "evidence test file missing from generator inventory");
  }
  if (!files.some((entry) => entry.path === CORRECTIVE4_TEST_REL)) {
    throw new EvidenceError("INVENTORY", "corrective4 test file missing from generator inventory");
  }
  return { files };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonNegativeSafeInt(value, label) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new EvidenceError("AUDIT", `${label} must be a finite non-negative safe integer`);
  }
}

/**
 * Generator audit derivation. Not imported by the verifier.
 * @param {string} text
 */
export function deriveAuditFacts(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceError("AUDIT", "audit JSON could not be parsed");
  }
  if (
    !isPlainObject(parsed) ||
    parsed.auditReportVersion !== 2 ||
    !isPlainObject(parsed.vulnerabilities)
  ) {
    throw new EvidenceError(
      "AUDIT",
      "audit JSON is not a v2 object with a plain vulnerabilities map",
    );
  }
  if (!isPlainObject(parsed.metadata) || !isPlainObject(parsed.metadata.vulnerabilities)) {
    throw new EvidenceError("AUDIT", "audit JSON missing metadata.vulnerabilities counts");
  }
  const metadataCounts = {};
  for (const key of AUDIT_COUNT_KEYS) {
    const value = parsed.metadata.vulnerabilities[key];
    assertNonNegativeSafeInt(value, `metadata.vulnerabilities.${key}`);
    metadataCounts[key] = value;
  }
  const severitySum =
    metadataCounts.info +
    metadataCounts.low +
    metadataCounts.moderate +
    metadataCounts.high +
    metadataCounts.critical;
  if (metadataCounts.total !== severitySum) {
    throw new EvidenceError("AUDIT", "metadata total does not equal severity sum");
  }
  const observedRowCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const vulnerabilityKeys = Object.keys(parsed.vulnerabilities).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const key of vulnerabilityKeys) {
    const row = parsed.vulnerabilities[key];
    if (!isPlainObject(row)) {
      throw new EvidenceError("AUDIT", `vulnerability row ${key} is not a plain object`);
    }
    const severity = row.severity;
    if (
      severity !== "info" &&
      severity !== "low" &&
      severity !== "moderate" &&
      severity !== "high" &&
      severity !== "critical"
    ) {
      throw new EvidenceError("AUDIT", `unknown severity ${String(severity)}`);
    }
    observedRowCounts[severity] += 1;
    observedRowCounts.total += 1;
  }
  const metadataMatchesRows = AUDIT_COUNT_KEYS.every(
    (key) => metadataCounts[key] === observedRowCounts[key],
  );
  if (!metadataMatchesRows) {
    throw new EvidenceError("AUDIT", "metadata counts do not match observed vulnerability rows");
  }
  const auditZero =
    metadataMatchesRows &&
    vulnerabilityKeys.length === 0 &&
    AUDIT_COUNT_KEYS.every((key) => metadataCounts[key] === 0);
  if (!auditZero) {
    throw new EvidenceError("AUDIT", "generator requires independently derived auditZero");
  }
  return {
    auditReportVersion: 2,
    metadataCounts,
    observedRowCounts,
    metadataMatchesRows,
    vulnerabilityKeys,
    auditZero,
  };
}

function normalizeRepository(url) {
  const trimmed = url.trim().replace(/\.git$/, "");
  const match = /github\.com[:/]([^/]+\/[^/]+)$/.exec(trimmed);
  return match?.[1] ?? null;
}

function readGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return null;
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

function isAncestor(repositoryRoot, ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repositoryRoot
 */
export function collectIdentity(repositoryRoot) {
  const testedCheckoutSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const testedCheckoutTreeSha = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
  const event = readGithubEvent();
  const remote = git(repositoryRoot, ["remote", "get-url", "origin"]);
  const repository = process.env.GITHUB_REPOSITORY ?? normalizeRepository(remote) ?? REPOSITORY;
  let sourceHeadSha = testedCheckoutSha;
  let sourceBranch = git(repositoryRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let baseSha = git(repositoryRoot, ["merge-base", "HEAD", EXPECTED_BASE_SHA]);
  const githubRunId = process.env.GITHUB_RUN_ID ?? "local";
  const githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "local";
  const githubJob = process.env.GITHUB_JOB ?? "local";

  if (eventName === "pull_request") {
    const headSha = event?.pull_request?.head?.sha;
    const headRef = event?.pull_request?.head?.ref;
    const prBase = event?.pull_request?.base?.sha;
    const githubSha = process.env.GITHUB_SHA;
    if (typeof headSha !== "string" || typeof headRef !== "string" || typeof prBase !== "string") {
      throw new EvidenceError(
        "IDENTITY",
        "pull_request event payload is missing head/base identity",
      );
    }
    if (typeof githubSha !== "string") {
      throw new EvidenceError("IDENTITY", "GITHUB_SHA is required for pull_request");
    }
    sourceHeadSha = headSha;
    sourceBranch = headRef;
    baseSha = prBase;
    if (sourceHeadSha === githubSha || sourceHeadSha === testedCheckoutSha) {
      throw new EvidenceError("IDENTITY", "PR source HEAD must not equal the merge checkout");
    }
    if (testedCheckoutSha !== githubSha) {
      throw new EvidenceError("IDENTITY", "PR tested checkout must equal GITHUB_SHA");
    }
    if (!isAncestor(repositoryRoot, sourceHeadSha, testedCheckoutSha)) {
      throw new EvidenceError("IDENTITY", "PR source HEAD is not an ancestor of tested checkout");
    }
  } else if (eventName === "push") {
    const githubSha = process.env.GITHUB_SHA;
    const refName = process.env.GITHUB_REF_NAME;
    if (typeof githubSha !== "string" || typeof refName !== "string") {
      throw new EvidenceError("IDENTITY", "push event requires GITHUB_SHA and GITHUB_REF_NAME");
    }
    if (githubSha !== testedCheckoutSha) {
      throw new EvidenceError("IDENTITY", "push GITHUB_SHA must equal git HEAD");
    }
    sourceHeadSha = githubSha;
    sourceBranch = refName;
  } else if (eventName !== "local") {
    throw new EvidenceError("IDENTITY", `unsupported githubEventName ${eventName}`);
  }

  if (!isAncestor(repositoryRoot, IMPLEMENTATION_BASE_SHA, sourceHeadSha)) {
    throw new EvidenceError("IDENTITY", "implementation base is not an ancestor of source HEAD");
  }
  if (!isAncestor(repositoryRoot, IMPLEMENTATION_BASE_SHA, testedCheckoutSha)) {
    throw new EvidenceError(
      "IDENTITY",
      "implementation base is not an ancestor of tested checkout",
    );
  }

  const sourceHeadTreeSha = git(repositoryRoot, ["rev-parse", `${sourceHeadSha}^{tree}`]);
  return {
    repository,
    sourceBranch,
    sourceHeadSha,
    sourceHeadTreeSha,
    testedCheckoutSha,
    testedCheckoutTreeSha,
    baseSha,
    implementationBaseSha: IMPLEMENTATION_BASE_SHA,
    githubEventName: eventName,
    githubRunId,
    githubRunAttempt,
    githubJob,
    generatedAt: new Date().toISOString(),
  };
}

function resolveNpmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  const sibling = path.join(path.dirname(process.execPath), "npm");
  if (existsSync(sibling)) {
    return sibling;
  }
  throw new EvidenceError("TOOLCHAIN", "npm CLI path could not be resolved without PATH shelling");
}

/**
 * @param {string} repositoryRoot
 */
export function collectToolchain(repositoryRoot) {
  const npmCli = resolveNpmCli();
  const npmVersion = execFileSync(process.execPath, [npmCli, "--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const nodeVersion = process.version;
  if (nodeVersion !== PINNED_NODE) {
    throw new EvidenceError("TOOLCHAIN", `node is ${nodeVersion}, required ${PINNED_NODE}`);
  }
  if (npmVersion !== PINNED_NPM) {
    throw new EvidenceError("TOOLCHAIN", `npm is ${npmVersion}, required ${PINNED_NPM}`);
  }
  return {
    nodeVersion,
    npmVersion,
    operatingSystem: os.type(),
    architecture: process.arch,
  };
}

/**
 * @param {readonly string[]} argv
 * @param {object} options
 */
export function spawnArgv(argv, options) {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new EvidenceError("COMMAND", "empty argv");
  }
  if (command === "npm") {
    return spawnSync(process.execPath, [resolveNpmCli(), ...args], options);
  }
  return spawnSync(command, args, options);
}

/**
 * @param {string} text
 * @param {string} repositoryRoot
 */
export function stripHostPaths(text, repositoryRoot) {
  const replacements = [repositoryRoot, path.resolve(repositoryRoot), os.homedir()].filter(
    (value) => typeof value === "string" && value.length > 1,
  );
  replacements.sort((left, right) => right.length - left.length);
  let output = text;
  for (const absolute of replacements) {
    output = output.split(absolute).join(".");
    output = output.split(absolute.replaceAll("\\", "/")).join(".");
  }
  const runnerWork = "/home/runner/work";
  output = output.split(runnerWork).join(".");
  output = output.split(`file://${path.resolve(repositoryRoot)}`).join("file://.");
  return output
    .replace(
      /(^|[\s:(["'`])(?:\/(?:Users|home|opt|usr|var|private|tmp|workspace|root)\/[^\s"'`)]+)/g,
      "$1.",
    )
    .replace(/(^|[\s:(["'`])[A-Za-z]:\\[^\s"'`)]+/g, "$1.");
}

/**
 * @param {string} text
 * @param {string} label
 */
export function assertNoSecretOrAbsolute(text, label) {
  if (ABSOLUTE_PATH_PATTERN.test(text)) {
    throw new EvidenceError("PATH", `${label} contains an absolute filesystem path`);
  }
  for (const { id, pattern } of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) {
      throw new EvidenceError("SECRET", `${label} contains secret-like value (${id})`);
    }
  }
}

function commandLogName(name) {
  return name.replaceAll(":", "-");
}

function isoNow() {
  return new Date().toISOString();
}

function rejectGateVerdictText(text) {
  for (const pattern of GATE_VERDICT_TEXT) {
    if (pattern.test(text)) {
      throw new EvidenceError("GATE_VERDICT", "artifact contains a self-declared gate verdict");
    }
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} logsDir
 * @param {{ name: string, argv: readonly string[] }} command
 */
export function runRecordedCommand(repositoryRoot, logsDir, command) {
  const startedAt = isoNow();
  const result = spawnArgv(command.argv, {
    cwd: repositoryRoot,
    encoding: "buffer",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const completedAt = isoNow();
  const stdout = stripHostPaths(Buffer.from(result.stdout ?? "").toString("utf8"), repositoryRoot);
  const stderr = stripHostPaths(Buffer.from(result.stderr ?? "").toString("utf8"), repositoryRoot);
  const stdoutFile = `logs/${commandLogName(command.name)}.stdout.log`;
  const stderrFile = `logs/${commandLogName(command.name)}.stderr.log`;
  writeFileSync(path.join(logsDir, path.basename(stdoutFile)), stdout);
  writeFileSync(path.join(logsDir, path.basename(stderrFile)), stderr);
  assertNoSecretOrAbsolute(stdout, stdoutFile);
  assertNoSecretOrAbsolute(stderr, stderrFile);
  rejectGateVerdictText(stdout);
  rejectGateVerdictText(stderr);
  const exitCode = result.status === 0 ? 0 : (result.status ?? 1);
  return {
    name: command.name,
    argv: [...command.argv],
    exitCode,
    stdoutFile,
    stderrFile,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    startedAt,
    completedAt,
  };
}

function listTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolutePath] : [];
  });
}

function envMatches(patterns) {
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (name === "GITHUB_TOKEN" || name === "npm_config_user_agent") {
      continue;
    }
    if (patterns.some((pattern) => pattern.test(name))) {
      return true;
    }
  }
  return false;
}

/**
 * Generator-owned safety derivation. Not imported by the verifier.
 * @param {string} repositoryRoot
 * @param {string} dryRunStdout
 */
export function deriveSafetyAttestations(repositoryRoot, dryRunStdout) {
  let liveExchangeWrite = false;
  const dryRunLines = dryRunStdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const dryRunLine = dryRunLines.at(-1);
  if (dryRunLine === undefined) {
    throw new EvidenceError("SAFETY", "dry-run stdout is empty; live write attestation unproven");
  }
  let report;
  try {
    report = JSON.parse(dryRunLine);
  } catch {
    throw new EvidenceError("SAFETY", "dry-run stdout is not JSON");
  }
  if (
    report.liveExchangeWrites !== false ||
    report.runtimeMode !== "DRY_RUN" ||
    report.phase !== 0
  ) {
    liveExchangeWrite = true;
  }
  if (process.env.RUNTIME_MODE === "LIVE" || process.env.LIVE_EXCHANGE_WRITE === "true") {
    liveExchangeWrite = true;
  }

  const sourceRoot = path.join(repositoryRoot, "src");
  let sawSystemAllowFalse = false;
  let systemAllowRiskIncrease = process.env.SYSTEM_ALLOW_RISK_INCREASE === "true";
  for (const filePath of listTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    if (
      NETWORK_IMPORT.test(source) ||
      source.includes("placeOrder") ||
      source.includes("cancelOrder")
    ) {
      liveExchangeWrite = true;
    }
    if (/systemAllowRiskIncrease\s*[:=]\s*true/.test(source)) {
      systemAllowRiskIncrease = true;
    }
    if (/systemAllowRiskIncrease\s*[:=]\s*false/.test(source)) {
      sawSystemAllowFalse = true;
    }
  }
  if (!sawSystemAllowFalse) {
    throw new EvidenceError("SAFETY", "systemAllowRiskIncrease=false was not observed in src/");
  }

  const productionCredentialUsed = envMatches(PRODUCTION_CREDENTIAL_ENV);
  const testnetTradingKeyUsed = envMatches(TESTNET_CREDENTIAL_ENV);
  const mergeHead = path.join(repositoryRoot, ".git", "MERGE_HEAD");
  const eventName = process.env.GITHUB_EVENT_NAME ?? "local";
  const refName = process.env.GITHUB_REF_NAME ?? "";
  const mergePerformed =
    eventName === "merge_group" ||
    existsSync(mergeHead) ||
    (eventName === "push" && refName === "main");
  const job = process.env.GITHUB_JOB ?? "";
  const workflow = readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const deployPerformed =
    eventName === "release" ||
    Boolean(process.env.DEPLOYMENT_ENVIRONMENT) ||
    /deploy/i.test(job) ||
    /npm publish|docker push|kubectl |helm /i.test(workflow);

  const tracked = listTrackedFiles(repositoryRoot);
  const contract = readFileSync(
    path.join(repositoryRoot, "docs/IMPLEMENTATION_CONTRACT.md"),
    "utf8",
  );
  const phase2dContract = readFileSync(
    path.join(repositoryRoot, "docs/PHASE_2D_CONTRACT.md"),
    "utf8",
  );
  let phase2EStarted = false;
  if (
    !contract.includes("PHASE_2E_STARTED=NO") ||
    contract.includes("PHASE_2E_STARTED=YES") ||
    contract.includes("PHASE_2E_AUTHORIZED=YES") ||
    !phase2dContract.includes("PHASE_2E_STARTED=NO") ||
    phase2dContract.includes("PHASE_2E_STARTED=YES")
  ) {
    phase2EStarted = true;
  }
  if (
    tracked.some(
      (relativePath) =>
        /^src\/.*(?:halt-ack|halt_ack|durable-halt|HaltState)/i.test(relativePath) ||
        /^src\/risk\/halt/i.test(relativePath) ||
        /^test\/phase2e\//i.test(relativePath),
    )
  ) {
    phase2EStarted = true;
  }

  return {
    systemAllowRiskIncrease,
    liveExchangeWrite,
    productionCredentialUsed,
    testnetTradingKeyUsed,
    mergePerformed,
    deployPerformed,
    phase2EStarted,
  };
}

function assertSafetyAllFalse(safety) {
  for (const key of SAFETY_KEYS) {
    if (safety[key] !== false) {
      throw new EvidenceError("SAFETY", `${key} must be false from scan results`);
    }
  }
}

function emptySuccessLog(name) {
  return `${name} synthetic fixture\n`;
}

function zeroAuditStdout() {
  return `${JSON.stringify(
    {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 0,
        },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 */
export function writeSyntheticArtifact(repositoryRoot, artifactRoot) {
  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(path.join(artifactRoot, "logs"), { recursive: true });

  const identity = collectIdentity(repositoryRoot);
  const toolchain = collectToolchain(repositoryRoot);
  const startedAt = isoNow();
  const completedAt = isoNow();
  const commands = REQUIRED_COMMANDS.map((command) => {
    let stdout = emptySuccessLog(command.name);
    if (command.name === "test:phase2d-corrective-4") {
      stdout = renderTap(CORRECTIVE4_FOCUSED_TOTAL, CORRECTIVE4_FOCUSED_TOTAL);
    } else if (command.name === "test:evidence:phase2d-corrective4") {
      stdout = renderTap(EVIDENCE_VERIFIER_TOTAL, EVIDENCE_VERIFIER_TOTAL);
    } else if (command.name === "test") {
      stdout = renderTap(EXPECTED_FULL_TOTAL, EXPECTED_FULL_TOTAL);
    } else if (command.name === "dry-run") {
      const tsxCli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const result = spawnSync(process.execPath, [tsxCli, "src/index.ts"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, RUNTIME_MODE: "DRY_RUN" },
      });
      if (result.status !== 0) {
        throw new EvidenceError("SAFETY", "synthetic dry-run failed");
      }
      stdout = stripHostPaths(result.stdout, repositoryRoot);
    } else if (command.name === "audit") {
      stdout = zeroAuditStdout();
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

  const dryRun = commands.find((command) => command.name === "dry-run");
  if (dryRun === undefined) {
    throw new EvidenceError("COMMAND", "dry-run command missing from synthetic fixture");
  }
  const dryRunStdout = readFileSync(path.join(artifactRoot, dryRun.stdoutFile), "utf8");
  const safety = deriveSafetyAttestations(repositoryRoot, dryRunStdout);
  assertSafetyAllFalse(safety);
  const fileCommitment = collectFileCommitment(repositoryRoot);
  const testFileInventory = collectTestFileInventory(repositoryRoot);
  const focused = parseTapSummary(
    readFileSync(path.join(artifactRoot, "logs/test-phase2d-corrective-4.stdout.log"), "utf8"),
  );
  const evidence = parseTapSummary(
    readFileSync(
      path.join(artifactRoot, "logs/test-evidence-phase2d-corrective4.stdout.log"),
      "utf8",
    ),
  );
  const full = parseTapSummary(
    readFileSync(path.join(artifactRoot, "logs/test.stdout.log"), "utf8"),
  );
  const auditStdout = readFileSync(path.join(artifactRoot, "logs/audit.stdout.log"), "utf8");
  writeFileSync(path.join(artifactRoot, "audit.json"), auditStdout);
  const auditFacts = deriveAuditFacts(auditStdout);

  const manifest = {
    schema: SCHEMA_ID,
    identity,
    toolchain,
    commands,
    testFacts: {
      priorCumulativeTestTotal: PRIOR_CUMULATIVE_TEST_TOTAL,
      corrective4: focused,
      evidenceVerifier: evidence,
      full,
    },
    auditFacts,
    safety,
    fileCommitment,
    testFileInventory,
  };
  writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(artifactRoot, "file-hashes.json"),
    `${JSON.stringify(fileCommitment, null, 2)}\n`,
  );
  return manifest;
}

/**
 * @param {string} repositoryRoot
 */
export function generateEvidence(repositoryRoot) {
  const artifactRoot = artifactDir(repositoryRoot);
  rmSync(artifactRoot, { recursive: true, force: true });
  const logsDir = path.join(artifactRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  const toolchain = collectToolchain(repositoryRoot);
  const identity = collectIdentity(repositoryRoot);
  const commands = [];
  for (const command of REQUIRED_COMMANDS) {
    const recorded = runRecordedCommand(repositoryRoot, logsDir, command);
    commands.push(recorded);
    if (recorded.exitCode !== 0) {
      throw new EvidenceError("COMMAND", `${command.name} exited ${recorded.exitCode}`);
    }
  }

  const logs = Object.fromEntries(
    commands.map((command) => [
      command.name,
      readFileSync(path.join(artifactRoot, command.stdoutFile), "utf8"),
    ]),
  );
  const focused = parseTapSummary(logs["test:phase2d-corrective-4"]);
  const evidence = parseTapSummary(logs["test:evidence:phase2d-corrective4"]);
  const full = parseTapSummary(logs.test);
  if (focused.fail !== 0 || focused.skip !== 0 || focused.todo !== 0 || focused.cancelled !== 0) {
    throw new EvidenceError("TEST_FACTS", "corrective4 TAP is not clean");
  }
  if (
    evidence.fail !== 0 ||
    evidence.skip !== 0 ||
    evidence.todo !== 0 ||
    evidence.cancelled !== 0
  ) {
    throw new EvidenceError("TEST_FACTS", "evidenceVerifier TAP is not clean");
  }
  if (full.fail !== 0 || full.skip !== 0 || full.todo !== 0 || full.cancelled !== 0) {
    throw new EvidenceError("TEST_FACTS", "full TAP is not clean");
  }
  if (focused.total !== CORRECTIVE4_FOCUSED_TOTAL || focused.pass !== CORRECTIVE4_FOCUSED_TOTAL) {
    throw new EvidenceError("TEST_FACTS", "Corrective 4 focused suite is no longer 15 tests");
  }
  if (evidence.total !== EVIDENCE_VERIFIER_TOTAL || evidence.pass !== EVIDENCE_VERIFIER_TOTAL) {
    throw new EvidenceError("TEST_FACTS", "evidence verifier suite count mismatch");
  }
  if (
    full.total !== EXPECTED_FULL_TOTAL ||
    full.total !== PRIOR_CUMULATIVE_TEST_TOTAL + evidence.total
  ) {
    throw new EvidenceError("TEST_FACTS", "full test total is not 428 + evidenceVerifier.total");
  }

  writeFileSync(path.join(artifactRoot, "audit.json"), logs.audit);
  const auditFacts = deriveAuditFacts(logs.audit);
  const safety = deriveSafetyAttestations(repositoryRoot, logs["dry-run"]);
  assertSafetyAllFalse(safety);
  const fileCommitment = collectFileCommitment(repositoryRoot);
  const testFileInventory = collectTestFileInventory(repositoryRoot);

  const manifest = {
    schema: SCHEMA_ID,
    identity,
    toolchain,
    commands,
    testFacts: {
      priorCumulativeTestTotal: PRIOR_CUMULATIVE_TEST_TOTAL,
      corrective4: focused,
      evidenceVerifier: evidence,
      full,
    },
    auditFacts,
    safety,
    fileCommitment,
    testFileInventory,
  };
  writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(artifactRoot, "file-hashes.json"),
    `${JSON.stringify(fileCommitment, null, 2)}\n`,
  );
  return manifest;
}

/**
 * @param {string} fileUrl
 */
export function repositoryRootFromImportMeta(fileUrl) {
  return path.resolve(path.dirname(new URL(fileUrl).pathname), "../..");
}
