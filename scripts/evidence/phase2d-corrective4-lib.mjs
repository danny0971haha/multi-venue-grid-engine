import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_ID = "multi-venue-phase2d-corrective4/1";
export const VERIFIER_SCHEMA_ID = "multi-venue-phase2d-corrective4-verifier/1";
export const ARTIFACT_DIR_REL = "artifacts/phase2d-corrective4";
export const REPOSITORY = "danny0971haha/multi-venue-grid-engine";
export const SOURCE_BRANCH = "experiment/v0.1-phase2";
export const IMPLEMENTATION_BASE_SHA = "c64fa291af0d53139c6c526cd25ede434c08c17b";
export const EXPECTED_BASE_SHA = "057732cee021889d17573425ee4f24e2065df1e9";
export const PINNED_NODE = "v22.23.2";
export const PINNED_NPM = "10.9.8";
export const PRIOR_CUMULATIVE_TEST_TOTAL = 428;
export const CORRECTIVE4_FOCUSED_TOTAL = 15;

export const REQUIRED_COMMANDS = Object.freeze([
  Object.freeze({ name: "format:check", argv: Object.freeze(["npm", "run", "format:check"]) }),
  Object.freeze({ name: "lint", argv: Object.freeze(["npm", "run", "lint"]) }),
  Object.freeze({ name: "typecheck", argv: Object.freeze(["npm", "run", "typecheck"]) }),
  Object.freeze({
    name: "test:phase2d-corrective-4",
    argv: Object.freeze(["npm", "run", "test:phase2d-corrective-4"]),
  }),
  Object.freeze({ name: "test", argv: Object.freeze(["npm", "test"]) }),
  Object.freeze({ name: "build", argv: Object.freeze(["npm", "run", "build"]) }),
  Object.freeze({ name: "scan:secrets", argv: Object.freeze(["npm", "run", "scan:secrets"]) }),
  Object.freeze({ name: "dry-run", argv: Object.freeze(["npm", "run", "dry-run"]) }),
  Object.freeze({
    name: "audit",
    argv: Object.freeze(["npm", "audit", "--omit=dev", "--json"]),
  }),
]);

export const MANIFEST_KEYS = Object.freeze([
  "schema",
  "identity",
  "toolchain",
  "commands",
  "testFacts",
  "safety",
  "fileCommitment",
]);

export const IDENTITY_KEYS = Object.freeze([
  "repository",
  "sourceBranch",
  "sourceHeadSha",
  "sourceHeadTreeSha",
  "testedCheckoutSha",
  "testedCheckoutTreeSha",
  "baseSha",
  "implementationBaseSha",
  "githubEventName",
  "githubRunId",
  "githubRunAttempt",
  "githubJob",
  "generatedAt",
]);

export const TOOLCHAIN_KEYS = Object.freeze([
  "nodeVersion",
  "npmVersion",
  "operatingSystem",
  "architecture",
]);

export const COMMAND_KEYS = Object.freeze([
  "name",
  "argv",
  "exitCode",
  "stdoutFile",
  "stderrFile",
  "stdoutSha256",
  "stderrSha256",
  "startedAt",
  "completedAt",
]);

export const TEST_COUNT_KEYS = Object.freeze([
  "total",
  "pass",
  "fail",
  "skip",
  "todo",
  "cancelled",
]);

export const TEST_FACTS_KEYS = Object.freeze(["priorCumulativeTestTotal", "corrective4", "full"]);

export const SAFETY_KEYS = Object.freeze([
  "systemAllowRiskIncrease",
  "liveExchangeWrite",
  "productionCredentialUsed",
  "testnetTradingKeyUsed",
  "mergePerformed",
  "deployPerformed",
  "phase2EStarted",
]);

export const FILE_COMMITMENT_KEYS = Object.freeze(["files"]);
export const FILE_HASH_KEYS = Object.freeze(["path", "sha256"]);

const FORBIDDEN_MANIFEST_KEYS = new Set([
  "verdict",
  "requestedVerdict",
  "requestedDecision",
  "gateVerdict",
  "gateDecision",
  "selfDeclaredPass",
  "selfVerdict",
  "reviewerDecision",
  "accept",
  "ACCEPT",
  "PASS",
]);

const GATE_VERDICT_TEXT = [
  /"PHASE_2D_CORRECTIVE_4"\s*:\s*"(PASS|ACCEPT)"/,
  /"PHASE_2D_CORRECTIVE_4_EVIDENCE"\s*:\s*"(PASS|ACCEPT)"/,
  /"GATE_2"\s*:\s*"PASS"/,
  /"PHASE_2D"\s*:\s*"PASS"/,
  /"verdict"\s*:\s*"(PASS|ACCEPT)"/,
  /"requestedVerdict"\s*:\s*"(PASS|ACCEPT)"/,
  /"requestedDecision"\s*:\s*"(PASS|ACCEPT)"/,
];

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

const COMMITMENT_EXACT = new Set([
  "src/persistence/canonical-json.ts",
  "package.json",
  "package-lock.json",
  "docs/PHASE_2D_CONTRACT.md",
  "docs/PHASE_2D_CORRECTIVE_4_EVIDENCE.md",
  "docs/PHASE_2D_CORRECTIVE_4_EVIDENCE_SCHEMA.md",
  "docs/IMPLEMENTATION_CONTRACT.md",
  ".github/workflows/ci.yml",
  ".github/workflows/README.md",
]);

const COMMITMENT_PREFIXES = ["src/risk/", "test/risk/", "scripts/evidence/", "test/evidence/"];

export class EvidenceError extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "EvidenceError";
    this.code = code;
  }
}

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
 * @param {string} relativePath
 */
export function isCommitmentPath(relativePath) {
  if (COMMITMENT_EXACT.has(relativePath)) {
    return true;
  }
  return COMMITMENT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} label
 */
export function assertExactKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvidenceError("SCHEMA", `${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) {
    throw new EvidenceError("SCHEMA", `${label} has unauthorized or missing keys`);
  }
  for (let index = 0; index < allowed.length; index += 1) {
    if (keys[index] !== allowed[index]) {
      throw new EvidenceError("SCHEMA", `${label} key order or name mismatch at ${allowed[index]}`);
    }
  }
  for (const key of keys) {
    if (FORBIDDEN_MANIFEST_KEYS.has(key)) {
      throw new EvidenceError("GATE_VERDICT", `${label} contains forbidden key ${key}`);
    }
  }
}

/**
 * @param {unknown} node
 * @param {string} label
 */
export function rejectForbiddenKeys(node, label) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      rejectForbiddenKeys(item, `${label}[${index}]`);
    }
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (FORBIDDEN_MANIFEST_KEYS.has(key)) {
      throw new EvidenceError("GATE_VERDICT", `${label}.${key} is a forbidden gate verdict field`);
    }
    rejectForbiddenKeys(child, `${label}.${key}`);
  }
}

/**
 * @param {string} text
 */
export function rejectGateVerdictText(text) {
  for (const pattern of GATE_VERDICT_TEXT) {
    if (pattern.test(text)) {
      throw new EvidenceError("GATE_VERDICT", "artifact contains a self-declared gate verdict");
    }
  }
}

/**
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
 * @param {{ total: number, pass: number, fail: number, skip: number, todo: number, cancelled: number }} counts
 */
export function assertCleanCounts(counts, label) {
  if (counts.fail !== 0 || counts.skip !== 0 || counts.todo !== 0 || counts.cancelled !== 0) {
    throw new EvidenceError(
      "TEST_FACTS",
      `${label} must have fail=skip=todo=cancelled=0, observed ${JSON.stringify(counts)}`,
    );
  }
  if (counts.total !== counts.pass) {
    throw new EvidenceError("TEST_FACTS", `${label} total must equal pass`);
  }
}

/**
 * @param {number} total
 * @param {number} pass
 * @param {number} fail
 * @param {number} skip
 * @param {number} todo
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
 * @param {string} repositoryRoot
 */
export function listCommitmentFiles(repositoryRoot) {
  const matched = listTrackedFiles(repositoryRoot).filter(isCommitmentPath);
  const unique = new Set(matched);
  if (unique.size !== matched.length) {
    throw new EvidenceError("PATH", "duplicate commitment path");
  }
  const sorted = [...matched].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sorted.length === 0) {
    throw new EvidenceError("PATH", "commitment file list is empty");
  }
  for (const relativePath of sorted) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) {
      throw new EvidenceError("PATH", `missing commitment file: ${relativePath}`);
    }
  }
  return sorted;
}

/**
 * @param {string} repositoryRoot
 */
export function collectFileCommitment(repositoryRoot) {
  const files = listCommitmentFiles(repositoryRoot).map((relativePath) => ({
    path: relativePath,
    sha256: sha256File(path.join(repositoryRoot, relativePath)),
  }));
  return { files };
}

/**
 * @param {{ files: { path: string, sha256: string }[] }} commitment
 */
export function assertFileCommitmentSorted(commitment) {
  const paths = commitment.files.map((entry) => entry.path);
  for (const relativePath of paths) {
    assertSafeRelativePath(relativePath);
  }
  const unique = new Set(paths);
  if (unique.size !== paths.length) {
    throw new EvidenceError("PATH", "duplicate path in file commitment");
  }
  const sorted = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (let index = 0; index < paths.length; index += 1) {
    if (paths[index] !== sorted[index]) {
      throw new EvidenceError("PATH", "file commitment is not sorted by relative path");
    }
  }
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

  if (eventName === "pull_request" && event?.pull_request?.head?.sha) {
    sourceHeadSha = String(event.pull_request.head.sha);
    sourceBranch = String(event.pull_request.head.ref ?? SOURCE_BRANCH);
    baseSha = String(event.pull_request.base?.sha ?? EXPECTED_BASE_SHA);
  } else if (eventName === "push") {
    sourceHeadSha = process.env.GITHUB_SHA ?? testedCheckoutSha;
    sourceBranch = process.env.GITHUB_REF_NAME ?? sourceBranch;
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
    githubRunId: process.env.GITHUB_RUN_ID ?? "local",
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "local",
    githubJob: process.env.GITHUB_JOB ?? "local",
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
  const workflowPath = path.join(repositoryRoot, ".github/workflows/ci.yml");
  const workflow = readFileSync(workflowPath, "utf8");
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

/**
 * @param {Record<string, boolean>} safety
 */
export function assertSafetyAllFalse(safety) {
  for (const key of SAFETY_KEYS) {
    if (safety[key] !== false) {
      throw new EvidenceError("SAFETY", `${key} must be false from scan results`);
    }
  }
}

/**
 * @param {string} text
 */
export function parseAuditJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceError("AUDIT", "audit JSON could not be parsed");
  }
  const critical = parsed?.metadata?.vulnerabilities?.critical;
  const total = parsed?.metadata?.vulnerabilities?.total;
  if (typeof critical !== "number" || typeof total !== "number") {
    throw new EvidenceError("AUDIT", "audit JSON missing metadata.vulnerabilities counts");
  }
  if (critical > 0) {
    throw new EvidenceError("AUDIT", `audit reports ${critical} critical vulnerabilities`);
  }
  return parsed;
}

/**
 * @param {unknown} manifest
 */
export function assertManifestSchema(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, "manifest");
  if (manifest.schema !== SCHEMA_ID) {
    throw new EvidenceError("SCHEMA", `unexpected schema ${String(manifest.schema)}`);
  }
  rejectForbiddenKeys(manifest, "manifest");
  rejectGateVerdictText(JSON.stringify(manifest));
  assertExactKeys(manifest.identity, IDENTITY_KEYS, "identity");
  assertExactKeys(manifest.toolchain, TOOLCHAIN_KEYS, "toolchain");
  if (!Array.isArray(manifest.commands) || manifest.commands.length !== REQUIRED_COMMANDS.length) {
    throw new EvidenceError("SCHEMA", "commands must be the exact required list");
  }
  for (let index = 0; index < REQUIRED_COMMANDS.length; index += 1) {
    const expected = REQUIRED_COMMANDS[index];
    const observed = manifest.commands[index];
    assertExactKeys(observed, COMMAND_KEYS, `commands[${index}]`);
    if (observed.name !== expected.name) {
      throw new EvidenceError("SCHEMA", `command name mismatch at ${expected.name}`);
    }
    if (!Array.isArray(observed.argv) || observed.argv.join("\0") !== expected.argv.join("\0")) {
      throw new EvidenceError("SCHEMA", `command argv mismatch for ${expected.name}`);
    }
    assertSafeRelativePath(observed.stdoutFile);
    assertSafeRelativePath(observed.stderrFile);
    if (!observed.stdoutFile.startsWith("logs/") || !observed.stderrFile.startsWith("logs/")) {
      throw new EvidenceError("PATH", `command logs must live under logs/ for ${expected.name}`);
    }
  }
  assertExactKeys(manifest.testFacts, TEST_FACTS_KEYS, "testFacts");
  assertExactKeys(manifest.testFacts.corrective4, TEST_COUNT_KEYS, "testFacts.corrective4");
  assertExactKeys(manifest.testFacts.full, TEST_COUNT_KEYS, "testFacts.full");
  assertExactKeys(manifest.safety, SAFETY_KEYS, "safety");
  assertExactKeys(manifest.fileCommitment, FILE_COMMITMENT_KEYS, "fileCommitment");
  if (!Array.isArray(manifest.fileCommitment.files)) {
    throw new EvidenceError("SCHEMA", "fileCommitment.files must be an array");
  }
  for (const [index, entry] of manifest.fileCommitment.files.entries()) {
    assertExactKeys(entry, FILE_HASH_KEYS, `fileCommitment.files[${index}]`);
  }
  assertFileCommitmentSorted(manifest.fileCommitment);
}

function parentCount(repositoryRoot, sha) {
  const line = git(repositoryRoot, ["rev-list", "--parents", "-n", "1", sha]);
  return line.split(" ").length - 1;
}

/**
 * @param {string} repositoryRoot
 * @param {object} identity
 */
export function assertIdentityAgainstGit(repositoryRoot, identity) {
  const liveTestedSha = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const liveTestedTree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  if (
    identity.testedCheckoutSha !== liveTestedSha ||
    identity.testedCheckoutTreeSha !== liveTestedTree
  ) {
    throw new EvidenceError("IDENTITY", "tested checkout SHA/tree does not match current git HEAD");
  }

  const liveSourceTree = git(repositoryRoot, ["rev-parse", `${identity.sourceHeadSha}^{tree}`]);
  if (identity.sourceHeadTreeSha !== liveSourceTree) {
    throw new EvidenceError("IDENTITY", "source tree SHA does not match git");
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? identity.githubEventName;
  if (identity.githubEventName !== eventName && process.env.GITHUB_EVENT_NAME) {
    throw new EvidenceError("IDENTITY", "githubEventName does not match execution environment");
  }

  const event = readGithubEvent();
  if (eventName === "pull_request") {
    const headSha = event?.pull_request?.head?.sha;
    const githubSha = process.env.GITHUB_SHA;
    if (typeof headSha !== "string" || identity.sourceHeadSha !== headSha) {
      throw new EvidenceError("IDENTITY", "PR source HEAD must equal pull_request.head.sha");
    }
    if (
      typeof githubSha === "string" &&
      githubSha !== headSha &&
      identity.sourceHeadSha === githubSha
    ) {
      throw new EvidenceError(
        "IDENTITY",
        "source HEAD was impersonated by the GitHub merge checkout",
      );
    }
    if (
      identity.sourceHeadSha === identity.testedCheckoutSha &&
      githubSha &&
      githubSha !== headSha
    ) {
      throw new EvidenceError(
        "IDENTITY",
        "PR source HEAD must not be recorded as the merge checkout",
      );
    }
    if (
      parentCount(repositoryRoot, identity.sourceHeadSha) > 1 &&
      identity.sourceHeadSha === githubSha
    ) {
      throw new EvidenceError("IDENTITY", "sourceHeadSha was changed to a merge commit");
    }
    const expectedBase = String(event?.pull_request?.base?.sha ?? EXPECTED_BASE_SHA);
    if (identity.baseSha !== expectedBase) {
      throw new EvidenceError("IDENTITY", "PR base SHA mismatch");
    }
  } else if (eventName === "push" || eventName === "local") {
    if (identity.sourceHeadSha !== identity.testedCheckoutSha && eventName === "local") {
      throw new EvidenceError("IDENTITY", "local source HEAD must equal tested checkout");
    }
    const liveBase = git(repositoryRoot, ["merge-base", "HEAD", EXPECTED_BASE_SHA]);
    if (identity.baseSha !== liveBase && identity.baseSha !== EXPECTED_BASE_SHA) {
      throw new EvidenceError("IDENTITY", "base SHA mismatch");
    }
  } else {
    throw new EvidenceError("IDENTITY", `unsupported githubEventName ${eventName}`);
  }

  if (identity.implementationBaseSha !== IMPLEMENTATION_BASE_SHA) {
    throw new EvidenceError("IDENTITY", "implementationBaseSha was altered");
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", IMPLEMENTATION_BASE_SHA, "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  } catch {
    throw new EvidenceError("IDENTITY", "implementation base is not an ancestor of HEAD");
  }

  if (identity.repository !== REPOSITORY) {
    throw new EvidenceError("IDENTITY", `repository must be ${REPOSITORY}`);
  }
  if (identity.sourceBranch !== SOURCE_BRANCH && eventName !== "pull_request") {
    if (identity.sourceBranch !== "HEAD") {
      throw new EvidenceError("IDENTITY", `sourceBranch must be ${SOURCE_BRANCH}`);
    }
  }
  if (eventName === "pull_request" && identity.sourceBranch !== SOURCE_BRANCH) {
    throw new EvidenceError("IDENTITY", `PR sourceBranch must be ${SOURCE_BRANCH}`);
  }
}

/**
 * @param {string} artifactRoot
 * @param {object} command
 */
export function assertCommandLogs(artifactRoot, command) {
  const stdoutPath = path.join(artifactRoot, command.stdoutFile);
  const stderrPath = path.join(artifactRoot, command.stderrFile);
  if (!existsSync(stdoutPath) || !existsSync(stderrPath)) {
    throw new EvidenceError("ARTIFACT", `missing log for ${command.name}`);
  }
  const stdout = readFileSync(stdoutPath, "utf8");
  const stderr = readFileSync(stderrPath, "utf8");
  if (sha256(stdout) !== command.stdoutSha256 || sha256(stderr) !== command.stderrSha256) {
    throw new EvidenceError("COMMAND", `raw log hash mismatch for ${command.name}`);
  }
  assertNoSecretOrAbsolute(stdout, command.stdoutFile);
  assertNoSecretOrAbsolute(stderr, command.stderrFile);
  if (command.exitCode !== 0) {
    throw new EvidenceError("COMMAND", `${command.name} exitCode must be 0`);
  }
  if (Date.parse(command.startedAt) > Date.parse(command.completedAt)) {
    throw new EvidenceError("COMMAND", `${command.name} timestamps are inverted`);
  }
  return { stdout, stderr };
}

/**
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 */
export function scanArtifactTree(artifactRoot) {
  /** @type {string[]} */
  const files = [];
  const walk = (directory, rel) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      assertSafeRelativePath(relativePath);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      files.push(relativePath);
      const text = readFileSync(absolutePath, "utf8");
      rejectGateVerdictText(text);
      if (entry.name.endsWith(".json") || entry.name.endsWith(".log")) {
        assertNoSecretOrAbsolute(text, relativePath);
      }
    }
  };
  walk(artifactRoot, "");
  return files;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 */
export function verifyEvidence(repositoryRoot, artifactRoot) {
  const issues = [];
  const fail = (error) => {
    issues.push(error instanceof EvidenceError ? `${error.code}: ${error.message}` : String(error));
  };

  try {
    const liveToolchain = collectToolchain(repositoryRoot);
    if (!existsSync(path.join(artifactRoot, "manifest.json"))) {
      throw new EvidenceError("ARTIFACT", "manifest.json is missing");
    }
    if (!existsSync(path.join(artifactRoot, "file-hashes.json"))) {
      throw new EvidenceError("ARTIFACT", "file-hashes.json is missing");
    }
    if (!existsSync(path.join(artifactRoot, "audit.json"))) {
      throw new EvidenceError("ARTIFACT", "audit.json is missing");
    }
    const manifestText = readFileSync(path.join(artifactRoot, "manifest.json"), "utf8");
    rejectGateVerdictText(manifestText);
    const manifest = JSON.parse(manifestText);
    assertManifestSchema(manifest);
    if (
      manifest.toolchain.nodeVersion !== PINNED_NODE ||
      manifest.toolchain.npmVersion !== PINNED_NPM
    ) {
      throw new EvidenceError("TOOLCHAIN", "manifest toolchain does not match the pin");
    }
    if (JSON.stringify(manifest.toolchain) !== JSON.stringify(liveToolchain)) {
      throw new EvidenceError("TOOLCHAIN", "manifest toolchain does not match this process");
    }
    assertIdentityAgainstGit(repositoryRoot, manifest.identity);

    const liveCommitment = collectFileCommitment(repositoryRoot);
    const recorded = manifest.fileCommitment.files;
    if (recorded.length !== liveCommitment.files.length) {
      throw new EvidenceError("FILE_HASH", "file commitment size mismatch");
    }
    for (let index = 0; index < recorded.length; index += 1) {
      const expected = liveCommitment.files[index];
      const observed = recorded[index];
      if (observed.path !== expected.path || observed.sha256 !== expected.sha256) {
        throw new EvidenceError("FILE_HASH", `file hash mismatch for ${expected.path}`);
      }
    }
    const inventory = readJson(path.join(artifactRoot, "file-hashes.json"));
    if (JSON.stringify(inventory) !== JSON.stringify(liveCommitment)) {
      throw new EvidenceError("FILE_HASH", "file-hashes.json does not match recomputed inventory");
    }

    const logsByName = new Map();
    for (const command of manifest.commands) {
      logsByName.set(command.name, assertCommandLogs(artifactRoot, command));
    }

    const focusedTap = parseTapSummary(logsByName.get("test:phase2d-corrective-4").stdout);
    const fullTap = parseTapSummary(logsByName.get("test").stdout);
    assertCleanCounts(focusedTap, "corrective4 TAP");
    assertCleanCounts(fullTap, "full TAP");
    if (
      focusedTap.total !== CORRECTIVE4_FOCUSED_TOTAL ||
      focusedTap.pass !== CORRECTIVE4_FOCUSED_TOTAL
    ) {
      throw new EvidenceError("TEST_FACTS", "Corrective 4 focused suite must remain 15/15");
    }
    if (fullTap.total < PRIOR_CUMULATIVE_TEST_TOTAL) {
      throw new EvidenceError(
        "TEST_FACTS",
        `full total ${fullTap.total} is below ${PRIOR_CUMULATIVE_TEST_TOTAL}`,
      );
    }
    if (JSON.stringify(manifest.testFacts.corrective4) !== JSON.stringify(focusedTap)) {
      throw new EvidenceError("TEST_FACTS", "corrective4 facts do not match TAP");
    }
    if (JSON.stringify(manifest.testFacts.full) !== JSON.stringify(fullTap)) {
      throw new EvidenceError("TEST_FACTS", "full facts do not match TAP");
    }
    if (manifest.testFacts.priorCumulativeTestTotal !== PRIOR_CUMULATIVE_TEST_TOTAL) {
      throw new EvidenceError("TEST_FACTS", "prior cumulative total was altered");
    }

    const auditText = readFileSync(path.join(artifactRoot, "audit.json"), "utf8");
    if (auditText !== logsByName.get("audit").stdout) {
      throw new EvidenceError("AUDIT", "audit.json bytes differ from recorded audit stdout");
    }
    parseAuditJson(auditText);

    const derivedSafety = deriveSafetyAttestations(
      repositoryRoot,
      logsByName.get("dry-run").stdout,
    );
    assertSafetyAllFalse(derivedSafety);
    if (JSON.stringify(derivedSafety) !== JSON.stringify(manifest.safety)) {
      throw new EvidenceError("SAFETY", "safety attestations do not match independent scans");
    }

    scanArtifactTree(artifactRoot);
  } catch (error) {
    fail(error);
  }

  const integrityOk = issues.length === 0;
  const result = {
    schema: VERIFIER_SCHEMA_ID,
    integrityOk,
    independentReview: "NOT_PERFORMED",
    gateStatus: "NOT_EMITTED",
    checkedAt: new Date().toISOString(),
    issues,
  };
  rejectGateVerdictText(JSON.stringify(result));
  writeFileSync(path.join(artifactRoot, "verifier.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!integrityOk) {
    throw new EvidenceError("VERIFY", issues.join("\n"));
  }
  return result;
}

function emptySuccessLog(name) {
  return `${name} synthetic fixture\n`;
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
    } else if (command.name === "test") {
      stdout = renderTap(PRIOR_CUMULATIVE_TEST_TOTAL, PRIOR_CUMULATIVE_TEST_TOTAL);
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
      stdout = `${JSON.stringify(
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
  const focused = parseTapSummary(
    readFileSync(path.join(artifactRoot, "logs/test-phase2d-corrective-4.stdout.log"), "utf8"),
  );
  const full = parseTapSummary(
    readFileSync(path.join(artifactRoot, "logs/test.stdout.log"), "utf8"),
  );
  const auditStdout = readFileSync(path.join(artifactRoot, "logs/audit.stdout.log"), "utf8");
  writeFileSync(path.join(artifactRoot, "audit.json"), auditStdout);

  const manifest = {
    schema: SCHEMA_ID,
    identity,
    toolchain,
    commands,
    testFacts: {
      priorCumulativeTestTotal: PRIOR_CUMULATIVE_TEST_TOTAL,
      corrective4: focused,
      full,
    },
    safety,
    fileCommitment,
  };
  assertManifestSchema(manifest);
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
  const full = parseTapSummary(logs.test);
  assertCleanCounts(focused, "corrective4");
  assertCleanCounts(full, "full");
  if (focused.total !== CORRECTIVE4_FOCUSED_TOTAL) {
    throw new EvidenceError("TEST_FACTS", "Corrective 4 focused suite is no longer 15 tests");
  }
  if (full.total < PRIOR_CUMULATIVE_TEST_TOTAL) {
    throw new EvidenceError("TEST_FACTS", "full test total dropped below 428");
  }

  writeFileSync(path.join(artifactRoot, "audit.json"), logs.audit);
  parseAuditJson(logs.audit);

  const safety = deriveSafetyAttestations(repositoryRoot, logs["dry-run"]);
  assertSafetyAllFalse(safety);
  const fileCommitment = collectFileCommitment(repositoryRoot);

  const manifest = {
    schema: SCHEMA_ID,
    identity,
    toolchain,
    commands,
    testFacts: {
      priorCumulativeTestTotal: PRIOR_CUMULATIVE_TEST_TOTAL,
      corrective4: focused,
      full,
    },
    safety,
    fileCommitment,
  };
  assertManifestSchema(manifest);
  writeFileSync(path.join(artifactRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(artifactRoot, "file-hashes.json"),
    `${JSON.stringify(fileCommitment, null, 2)}\n`,
  );
  scanArtifactTree(artifactRoot);
  return manifest;
}

/**
 * @param {string} fileUrl
 */
export function repositoryRootFromImportMeta(fileUrl) {
  return path.resolve(path.dirname(new URL(fileUrl).pathname), "../..");
}
