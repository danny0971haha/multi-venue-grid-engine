import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ALLOWED_TEST_SUITES,
  ARTIFACT_DIR_REL,
  AUDIT_COUNT_KEYS,
  AUDIT_FACTS_KEYS,
  CANONICAL_UINT_PATTERN,
  COMMAND_KEYS,
  COMMITMENT_EXACT,
  COMMITMENT_PREFIXES,
  CORRECTIVE4_FOCUSED_TOTAL,
  CORRECTIVE4_TEST_REL,
  EVIDENCE_TEST_REL,
  EVIDENCE_VERIFIER_TOTAL,
  EXPECTED_BASE_SHA,
  EXPECTED_DRY_RUN_SCRIPT,
  EXPECTED_FULL_TOTAL,
  EXPECTED_NPM_CORRECTIVE4_SCRIPT,
  EXPECTED_NPM_EVIDENCE_SCRIPT,
  EXPECTED_NPM_TEST_SCRIPT,
  EvidenceError,
  FILE_COMMITMENT_KEYS,
  FILE_HASH_KEYS,
  FORBIDDEN_MANIFEST_KEYS,
  IDENTITY_KEYS,
  IMPLEMENTATION_BASE_SHA,
  ISO_UTC_PATTERN,
  MANIFEST_KEYS,
  PINNED_NODE,
  PINNED_NPM,
  PRIOR_CUMULATIVE_TEST_TOTAL,
  REPOSITORY,
  REQUIRED_COMMANDS,
  REQUIRED_FULL_TEST_GLOBS,
  SAFETY_KEYS,
  SHA1_HEX_PATTERN,
  SOURCE_BRANCH,
  TEST_COUNT_KEYS,
  TEST_FACTS_KEYS,
  TEST_FILE_ENTRY_KEYS,
  TEST_FILE_INVENTORY_KEYS,
  TEST_SUITE_BY_DIR,
  TOOLCHAIN_KEYS,
  VERIFIER_OWNED_CORRECTIVE4_ARGV,
  VERIFIER_OWNED_EVIDENCE_ARGV,
  VERIFIER_SCHEMA_ID,
} from "./phase2d-corrective4-schema.mjs";

const FORBIDDEN_KEY_SET = new Set(FORBIDDEN_MANIFEST_KEYS);
const SHA1_HEX = new RegExp(SHA1_HEX_PATTERN);
const CANONICAL_UINT = new RegExp(CANONICAL_UINT_PATTERN);
const ISO_UTC = new RegExp(ISO_UTC_PATTERN);

const GATE_VERDICT_TEXT = [
  /"PHASE_2D_CORRECTIVE_4"\s*:\s*"(PASS|ACCEPT)"/,
  /"PHASE_2D_CORRECTIVE_4_EVIDENCE"\s*:\s*"(PASS|ACCEPT)"/,
  /"GATE_2"\s*:\s*"PASS"/,
  /"PHASE_2D"\s*:\s*"PASS"/,
  /"verdict"\s*:\s*"(PASS|ACCEPT)"/,
  /"requestedVerdict"\s*:/,
  /"requestedDecision"\s*:/,
  /"gateVerdict"\s*:/,
  /"gateDecision"\s*:/,
  /"selfDeclaredPass"\s*:/,
  /"ACCEPT"/,
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

const TAP_SUMMARY_FIELDS = Object.freeze([
  Object.freeze({ key: "total", pattern: /^# tests (\d+)\s*$/ }),
  Object.freeze({ key: "pass", pattern: /^# pass (\d+)\s*$/ }),
  Object.freeze({ key: "fail", pattern: /^# fail (\d+)\s*$/ }),
  Object.freeze({ key: "cancelled", pattern: /^# cancelled (\d+)\s*$/ }),
  Object.freeze({ key: "skip", pattern: /^# skipped (\d+)\s*$/ }),
  Object.freeze({ key: "todo", pattern: /^# todo (\d+)\s*$/ }),
]);

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
 * @param {unknown} value
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} label
 */
export function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) {
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
    if (FORBIDDEN_KEY_SET.has(key)) {
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
    if (FORBIDDEN_KEY_SET.has(key)) {
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

/**
 * Independent TAP parser: each summary field may appear once. Duplicates fail closed.
 * @param {string} text
 */
export function parseTapSummary(text) {
  /** @type {Record<string, number>} */
  const counts = {};
  /** @type {Set<string>} */
  const seen = new Set();

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }
    for (const field of TAP_SUMMARY_FIELDS) {
      const match = field.pattern.exec(line);
      if (!match) {
        continue;
      }
      if (seen.has(field.key)) {
        throw new EvidenceError("TAP", `duplicate TAP summary for ${field.key}`);
      }
      seen.add(field.key);
      counts[field.key] = Number(match[1]);
    }
  }

  for (const field of TAP_SUMMARY_FIELDS) {
    if (!seen.has(field.key) || !Number.isSafeInteger(counts[field.key])) {
      throw new EvidenceError("TAP", `TAP summary comments are missing ${field.key}`);
    }
  }

  return {
    total: counts.total,
    pass: counts.pass,
    fail: counts.fail,
    skip: counts.skip,
    todo: counts.todo,
    cancelled: counts.cancelled,
  };
}

/**
 * @param {{ total: number, pass: number, fail: number, skip: number, todo: number, cancelled: number }} counts
 * @param {string} label
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
 * @param {unknown} value
 * @param {string} label
 */
export function assertNonNegativeSafeInt(value, label) {
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
 * Independent audit parser. auditZero is derived from rows + metadata, never a constant.
 * @param {string} text
 */
export function parseAuditReport(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EvidenceError("AUDIT", "audit JSON could not be parsed");
  }
  if (!isPlainObject(parsed)) {
    throw new EvidenceError("AUDIT", "audit JSON must be an object");
  }
  if (parsed.auditReportVersion !== 2) {
    throw new EvidenceError("AUDIT", "auditReportVersion must be 2");
  }
  if (!isPlainObject(parsed.vulnerabilities)) {
    throw new EvidenceError("AUDIT", "vulnerabilities must be a plain object");
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
  const extraMetadata = Object.keys(parsed.metadata.vulnerabilities).filter(
    (key) => !AUDIT_COUNT_KEYS.includes(key),
  );
  if (extraMetadata.length > 0) {
    throw new EvidenceError("AUDIT", "metadata.vulnerabilities has unexpected keys");
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
  if (vulnerabilityKeys.length > 0) {
    throw new EvidenceError("AUDIT", "any vulnerability fails closed");
  }
  const auditZero =
    metadataMatchesRows &&
    vulnerabilityKeys.length === 0 &&
    AUDIT_COUNT_KEYS.every((key) => metadataCounts[key] === 0);
  if (!auditZero) {
    throw new EvidenceError("AUDIT", "auditZero derivation failed");
  }

  return {
    parsed,
    facts: {
      auditReportVersion: 2,
      metadataCounts,
      observedRowCounts,
      metadataMatchesRows,
      vulnerabilityKeys,
      auditZero,
    },
  };
}

/**
 * @param {unknown} pkg
 */
export function assertPackageScripts(pkg) {
  if (!isPlainObject(pkg) || !isPlainObject(pkg.scripts)) {
    throw new EvidenceError("PACKAGE_SCRIPT", "package.json scripts must be an object");
  }
  if (pkg.scripts.test !== EXPECTED_NPM_TEST_SCRIPT) {
    throw new EvidenceError(
      "PACKAGE_SCRIPT",
      "npm test script is not the exact expected expansion",
    );
  }
  if (pkg.scripts["test:phase2d-corrective-4"] !== EXPECTED_NPM_CORRECTIVE4_SCRIPT) {
    throw new EvidenceError("PACKAGE_SCRIPT", "corrective4 script mismatch");
  }
  if (pkg.scripts["test:evidence:phase2d-corrective4"] !== EXPECTED_NPM_EVIDENCE_SCRIPT) {
    throw new EvidenceError("PACKAGE_SCRIPT", "evidence verifier script mismatch");
  }
  if (pkg.scripts["dry-run"] !== EXPECTED_DRY_RUN_SCRIPT) {
    throw new EvidenceError("PACKAGE_SCRIPT", "dry-run script mismatch");
  }
  for (const glob of REQUIRED_FULL_TEST_GLOBS) {
    if (!String(pkg.scripts.test).includes(glob)) {
      throw new EvidenceError("PACKAGE_SCRIPT", `npm test is missing ${glob}`);
    }
  }
  if (!String(pkg.scripts.test).includes("test/evidence/*.test.ts")) {
    throw new EvidenceError("PACKAGE_SCRIPT", "evidence suite was removed from npm test");
  }
}

function git(repositoryRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new EvidenceError("IDENTITY", `git ${args.join(" ")} failed`);
  }
}

function gitTree(repositoryRoot, sha) {
  try {
    return execFileSync("git", ["rev-parse", `${sha}^{tree}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new EvidenceError("SHA", `tree SHA could not be resolved for ${sha}`);
  }
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
  const files = sorted.map((relativePath) => {
    const absolutePath = path.join(repositoryRoot, relativePath);
    if (!existsSync(absolutePath)) {
      throw new EvidenceError("PATH", `missing commitment file: ${relativePath}`);
    }
    return { path: relativePath, sha256: sha256File(absolutePath) };
  });
  return { files };
}

/**
 * @param {string} relativePath
 */
export function classifyTestSuite(relativePath) {
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
  const paths = files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new EvidenceError("INVENTORY", "duplicate test-file path");
  }
  if (!paths.includes(EVIDENCE_TEST_REL)) {
    throw new EvidenceError("INVENTORY", "evidence test file is missing from full inventory");
  }
  if (!paths.includes(CORRECTIVE4_TEST_REL)) {
    throw new EvidenceError("INVENTORY", "corrective4 test file is missing from full inventory");
  }
  return { files };
}

/**
 * @param {{ files: { path: string }[] }} inventory
 */
export function assertInventorySortedUnique(inventory) {
  const paths = inventory.files.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) {
    throw new EvidenceError("INVENTORY", "duplicate test-file path");
  }
  const sorted = [...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  for (let index = 0; index < paths.length; index += 1) {
    if (paths[index] !== sorted[index]) {
      throw new EvidenceError("INVENTORY", "test-file inventory is not sorted by relative path");
    }
  }
}

function readGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return null;
  }
  return JSON.parse(readFileSync(eventPath, "utf8"));
}

/**
 * @param {string} value
 * @param {string} label
 */
export function assertSha1Hex(value, label) {
  if (typeof value !== "string" || !SHA1_HEX.test(value)) {
    throw new EvidenceError("SHA", `${label} must be lowercase 40-hex`);
  }
}

/**
 * @param {string} value
 * @param {string} label
 */
export function assertIsoUtcTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_UTC.test(value)) {
    throw new EvidenceError("TIMESTAMP", `${label} is not a valid ISO-8601 UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new EvidenceError("TIMESTAMP", `${label} Date.parse is NaN`);
  }
  return parsed;
}

function assertCanonicalUintString(value, label) {
  if (typeof value !== "string" || !CANONICAL_UINT.test(value)) {
    throw new EvidenceError(
      "CI_IDENTITY",
      `${label} must be a canonical non-negative decimal integer string`,
    );
  }
}

/**
 * @param {string} repositoryRoot
 * @param {object} identity
 */
export function assertIdentityAgainstGit(repositoryRoot, identity) {
  const liveHead = git(repositoryRoot, ["rev-parse", "HEAD"]);
  const liveHeadTree = git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
  assertSha1Hex(identity.sourceHeadSha, "sourceHeadSha");
  assertSha1Hex(identity.sourceHeadTreeSha, "sourceHeadTreeSha");
  assertSha1Hex(identity.testedCheckoutSha, "testedCheckoutSha");
  assertSha1Hex(identity.testedCheckoutTreeSha, "testedCheckoutTreeSha");
  assertSha1Hex(identity.baseSha, "baseSha");
  assertSha1Hex(identity.implementationBaseSha, "implementationBaseSha");
  assertIsoUtcTimestamp(identity.generatedAt, "generatedAt");

  if (identity.testedCheckoutSha !== liveHead || identity.testedCheckoutTreeSha !== liveHeadTree) {
    throw new EvidenceError("IDENTITY", "tested checkout SHA/tree does not match current git HEAD");
  }
  const liveSourceTree = gitTree(repositoryRoot, identity.sourceHeadSha);
  if (identity.sourceHeadTreeSha !== liveSourceTree) {
    throw new EvidenceError("IDENTITY", "source tree SHA does not match git");
  }
  const liveTestedTree = gitTree(repositoryRoot, identity.testedCheckoutSha);
  if (identity.testedCheckoutTreeSha !== liveTestedTree) {
    throw new EvidenceError("IDENTITY", "tested tree SHA does not match git");
  }

  const envEvent = process.env.GITHUB_EVENT_NAME;
  const eventName = envEvent ?? identity.githubEventName;
  if (envEvent && identity.githubEventName !== envEvent) {
    throw new EvidenceError("IDENTITY", "githubEventName does not match execution environment");
  }
  if (identity.githubEventName !== eventName) {
    throw new EvidenceError("IDENTITY", "githubEventName mismatch");
  }
  if (identity.repository !== REPOSITORY) {
    throw new EvidenceError("IDENTITY", `repository must be ${REPOSITORY}`);
  }
  if (identity.implementationBaseSha !== IMPLEMENTATION_BASE_SHA) {
    throw new EvidenceError("IDENTITY", "implementationBaseSha was altered");
  }
  if (!isAncestor(repositoryRoot, identity.implementationBaseSha, identity.sourceHeadSha)) {
    throw new EvidenceError("IDENTITY", "implementation base is not an ancestor of source HEAD");
  }
  if (!isAncestor(repositoryRoot, identity.implementationBaseSha, identity.testedCheckoutSha)) {
    throw new EvidenceError(
      "IDENTITY",
      "implementation base is not an ancestor of tested checkout",
    );
  }

  const event = readGithubEvent();
  if (eventName === "push") {
    const githubSha = process.env.GITHUB_SHA;
    const refName = process.env.GITHUB_REF_NAME;
    if (identity.githubEventName !== "push") {
      throw new EvidenceError("IDENTITY", "push event name mismatch");
    }
    if (identity.sourceHeadSha !== githubSha) {
      throw new EvidenceError("IDENTITY", "push sourceHeadSha must equal GITHUB_SHA");
    }
    if (identity.testedCheckoutSha !== githubSha) {
      throw new EvidenceError("IDENTITY", "push testedCheckoutSha must equal GITHUB_SHA");
    }
    if (identity.sourceHeadSha !== liveHead || identity.testedCheckoutSha !== liveHead) {
      throw new EvidenceError("IDENTITY", "push SHAs must equal git rev-parse HEAD");
    }
    if (identity.sourceBranch !== refName) {
      throw new EvidenceError("IDENTITY", "push sourceBranch must equal GITHUB_REF_NAME");
    }
    if (identity.sourceHeadSha !== identity.testedCheckoutSha) {
      throw new EvidenceError("IDENTITY", "push source HEAD must be the tested checkout");
    }
    assertCiExecutionIdentity(identity);
  } else if (eventName === "pull_request") {
    const headSha = event?.pull_request?.head?.sha;
    const headRef = event?.pull_request?.head?.ref;
    const baseSha = event?.pull_request?.base?.sha;
    const githubSha = process.env.GITHUB_SHA;
    if (typeof headSha !== "string" || identity.sourceHeadSha !== headSha) {
      throw new EvidenceError("IDENTITY", "PR source HEAD must equal pull_request.head.sha");
    }
    if (typeof headRef !== "string" || identity.sourceBranch !== headRef) {
      throw new EvidenceError("IDENTITY", "PR sourceBranch must equal pull_request.head.ref");
    }
    if (typeof baseSha !== "string" || identity.baseSha !== baseSha) {
      throw new EvidenceError("IDENTITY", "PR base SHA mismatch");
    }
    if (identity.testedCheckoutSha !== githubSha) {
      throw new EvidenceError("IDENTITY", "PR testedCheckoutSha must equal GITHUB_SHA");
    }
    if (identity.testedCheckoutSha !== liveHead) {
      throw new EvidenceError("IDENTITY", "PR testedCheckoutSha must equal git rev-parse HEAD");
    }
    if (identity.sourceHeadSha === identity.testedCheckoutSha) {
      throw new EvidenceError("IDENTITY", "PR source HEAD must not equal the merge checkout");
    }
    if (!isAncestor(repositoryRoot, identity.sourceHeadSha, identity.testedCheckoutSha)) {
      throw new EvidenceError("IDENTITY", "PR source HEAD is not an ancestor of tested checkout");
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
    assertCiExecutionIdentity(identity);
  } else if (eventName === "local") {
    if (identity.sourceHeadSha !== identity.testedCheckoutSha) {
      throw new EvidenceError("IDENTITY", "local source HEAD must equal tested checkout");
    }
    if (identity.sourceHeadSha !== liveHead) {
      throw new EvidenceError("IDENTITY", "local source HEAD must equal git rev-parse HEAD");
    }
    if (identity.sourceBranch !== SOURCE_BRANCH && identity.sourceBranch !== "HEAD") {
      throw new EvidenceError("IDENTITY", `sourceBranch must be ${SOURCE_BRANCH}`);
    }
    const liveBase = git(repositoryRoot, ["merge-base", "HEAD", EXPECTED_BASE_SHA]);
    if (identity.baseSha !== liveBase && identity.baseSha !== EXPECTED_BASE_SHA) {
      throw new EvidenceError("IDENTITY", "base SHA mismatch");
    }
    if (typeof identity.githubJob !== "string" || identity.githubJob.length === 0) {
      throw new EvidenceError("CI_IDENTITY", "githubJob must be non-empty");
    }
  } else {
    throw new EvidenceError("IDENTITY", `unsupported githubEventName ${eventName}`);
  }
}

function assertCiExecutionIdentity(identity) {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  const job = process.env.GITHUB_JOB;
  if (identity.githubRunId !== runId) {
    throw new EvidenceError("CI_IDENTITY", "githubRunId does not match GITHUB_RUN_ID");
  }
  if (identity.githubRunAttempt !== runAttempt) {
    throw new EvidenceError("CI_IDENTITY", "githubRunAttempt does not match GITHUB_RUN_ATTEMPT");
  }
  if (identity.githubJob !== job) {
    throw new EvidenceError("CI_IDENTITY", "githubJob does not match GITHUB_JOB");
  }
  assertCanonicalUintString(identity.githubRunId, "githubRunId");
  assertCanonicalUintString(identity.githubRunAttempt, "githubRunAttempt");
  if (typeof identity.githubJob !== "string" || identity.githubJob.length === 0) {
    throw new EvidenceError("CI_IDENTITY", "githubJob must be non-empty");
  }
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
  if (command === "node") {
    return spawnSync(process.execPath, args, options);
  }
  return spawnSync(command, args, options);
}

/**
 * @param {string} repositoryRoot
 */
export function collectLiveToolchain(repositoryRoot) {
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
 * Verifier-owned safety derivation. Does not import generator safety helpers.
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
 * @param {unknown} manifest
 */
export function assertManifestSchema(manifest) {
  assertExactKeys(manifest, MANIFEST_KEYS, "manifest");
  if (manifest.schema !== "multi-venue-phase2d-corrective4/2") {
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
    const started = assertIsoUtcTimestamp(observed.startedAt, `${observed.name}.startedAt`);
    const completed = assertIsoUtcTimestamp(observed.completedAt, `${observed.name}.completedAt`);
    if (started > completed) {
      throw new EvidenceError("TIMESTAMP", `${observed.name} timestamps are inverted`);
    }
  }
  assertExactKeys(manifest.testFacts, TEST_FACTS_KEYS, "testFacts");
  assertExactKeys(manifest.testFacts.corrective4, TEST_COUNT_KEYS, "testFacts.corrective4");
  assertExactKeys(
    manifest.testFacts.evidenceVerifier,
    TEST_COUNT_KEYS,
    "testFacts.evidenceVerifier",
  );
  assertExactKeys(manifest.testFacts.full, TEST_COUNT_KEYS, "testFacts.full");
  assertExactKeys(manifest.auditFacts, AUDIT_FACTS_KEYS, "auditFacts");
  assertExactKeys(
    manifest.auditFacts.metadataCounts,
    AUDIT_COUNT_KEYS,
    "auditFacts.metadataCounts",
  );
  assertExactKeys(
    manifest.auditFacts.observedRowCounts,
    AUDIT_COUNT_KEYS,
    "auditFacts.observedRowCounts",
  );
  if (!Array.isArray(manifest.auditFacts.vulnerabilityKeys)) {
    throw new EvidenceError("SCHEMA", "auditFacts.vulnerabilityKeys must be an array");
  }
  if (typeof manifest.auditFacts.auditZero !== "boolean") {
    throw new EvidenceError("SCHEMA", "auditFacts.auditZero must be boolean");
  }
  if (typeof manifest.auditFacts.metadataMatchesRows !== "boolean") {
    throw new EvidenceError("SCHEMA", "auditFacts.metadataMatchesRows must be boolean");
  }
  if (manifest.auditFacts.auditReportVersion !== 2) {
    throw new EvidenceError("SCHEMA", "auditFacts.auditReportVersion must be 2");
  }
  assertExactKeys(manifest.safety, SAFETY_KEYS, "safety");
  assertExactKeys(manifest.fileCommitment, FILE_COMMITMENT_KEYS, "fileCommitment");
  if (!Array.isArray(manifest.fileCommitment.files)) {
    throw new EvidenceError("SCHEMA", "fileCommitment.files must be an array");
  }
  for (const [index, entry] of manifest.fileCommitment.files.entries()) {
    assertExactKeys(entry, FILE_HASH_KEYS, `fileCommitment.files[${index}]`);
  }
  assertExactKeys(manifest.testFileInventory, TEST_FILE_INVENTORY_KEYS, "testFileInventory");
  if (!Array.isArray(manifest.testFileInventory.files)) {
    throw new EvidenceError("SCHEMA", "testFileInventory.files must be an array");
  }
  for (const [index, entry] of manifest.testFileInventory.files.entries()) {
    assertExactKeys(entry, TEST_FILE_ENTRY_KEYS, `testFileInventory.files[${index}]`);
    assertSafeRelativePath(entry.path);
    if (!ALLOWED_TEST_SUITES.includes(entry.suite)) {
      throw new EvidenceError("INVENTORY", `unauthorized suite classification ${entry.suite}`);
    }
  }
  assertInventorySortedUnique(manifest.testFileInventory);
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
  return { stdout, stderr };
}

/**
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

function rerunRecordedCommand(repositoryRoot, argv) {
  const result = spawnArgv(argv, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new EvidenceError(
      "COMMAND",
      `independent rerun ${argv.join(" ")} exited ${result.status ?? 1}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function independentlyRerunCriticalCommands(repositoryRoot, logsByName) {
  const corrective4Tap = parseTapSummary(
    rerunRecordedCommand(repositoryRoot, VERIFIER_OWNED_CORRECTIVE4_ARGV),
  );
  const evidenceTap = parseTapSummary(
    rerunRecordedCommand(repositoryRoot, VERIFIER_OWNED_EVIDENCE_ARGV),
  );
  const fullTap = parseTapSummary(rerunRecordedCommand(repositoryRoot, ["npm", "test"]));
  const auditOutput = rerunRecordedCommand(repositoryRoot, [
    "npm",
    "audit",
    "--omit=dev",
    "--json",
  ]);
  const dryRunOutput = rerunRecordedCommand(repositoryRoot, ["npm", "run", "dry-run"]);

  assertCleanCounts(corrective4Tap, "independent corrective4 TAP");
  assertCleanCounts(evidenceTap, "independent evidenceVerifier TAP");
  assertCleanCounts(fullTap, "independent full TAP");
  if (
    JSON.stringify(corrective4Tap) !==
    JSON.stringify(parseTapSummary(logsByName.get("test:phase2d-corrective-4").stdout))
  ) {
    throw new EvidenceError(
      "TEST_FACTS",
      "independent corrective4 rerun does not match recorded TAP",
    );
  }
  if (
    JSON.stringify(evidenceTap) !==
    JSON.stringify(parseTapSummary(logsByName.get("test:evidence:phase2d-corrective4").stdout))
  ) {
    throw new EvidenceError("TEST_FACTS", "independent evidence rerun does not match recorded TAP");
  }
  if (JSON.stringify(fullTap) !== JSON.stringify(parseTapSummary(logsByName.get("test").stdout))) {
    throw new EvidenceError("TEST_FACTS", "independent full rerun does not match recorded TAP");
  }
  parseAuditReport(auditOutput);
  deriveSafetyAttestations(repositoryRoot, dryRunOutput);
}

/**
 * @param {string} repositoryRoot
 * @param {string} artifactRoot
 */
export function verifyEvidence(repositoryRoot, artifactRoot) {
  const issues = [];
  const fail = (error) => {
    issues.push(error instanceof EvidenceError ? error.message : String(error));
  };

  try {
    const liveToolchain = collectLiveToolchain(repositoryRoot);
    const pkg = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assertPackageScripts(pkg);
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
    const inventoryFile = JSON.parse(
      readFileSync(path.join(artifactRoot, "file-hashes.json"), "utf8"),
    );
    if (JSON.stringify(inventoryFile) !== JSON.stringify(liveCommitment)) {
      throw new EvidenceError("FILE_HASH", "file-hashes.json does not match recomputed inventory");
    }

    const liveTestInventory = collectTestFileInventory(repositoryRoot);
    if (JSON.stringify(manifest.testFileInventory) !== JSON.stringify(liveTestInventory)) {
      throw new EvidenceError("INVENTORY", "testFileInventory does not match verifier-owned scan");
    }
    if (!liveTestInventory.files.some((entry) => entry.path === EVIDENCE_TEST_REL)) {
      throw new EvidenceError("INVENTORY", "evidence test file is missing from full inventory");
    }

    const logsByName = new Map();
    for (const command of manifest.commands) {
      logsByName.set(command.name, assertCommandLogs(artifactRoot, command));
    }

    const focusedTap = parseTapSummary(logsByName.get("test:phase2d-corrective-4").stdout);
    const evidenceTap = parseTapSummary(logsByName.get("test:evidence:phase2d-corrective4").stdout);
    const fullTap = parseTapSummary(logsByName.get("test").stdout);
    assertCleanCounts(focusedTap, "corrective4 TAP");
    assertCleanCounts(evidenceTap, "evidenceVerifier TAP");
    assertCleanCounts(fullTap, "full TAP");
    if (
      focusedTap.total !== CORRECTIVE4_FOCUSED_TOTAL ||
      focusedTap.pass !== CORRECTIVE4_FOCUSED_TOTAL
    ) {
      throw new EvidenceError("TEST_FACTS", "Corrective 4 focused suite must remain 15/15");
    }
    if (
      evidenceTap.total !== EVIDENCE_VERIFIER_TOTAL ||
      evidenceTap.pass !== EVIDENCE_VERIFIER_TOTAL
    ) {
      throw new EvidenceError("TEST_FACTS", "evidence verifier suite count mismatch");
    }
    if (fullTap.total !== EXPECTED_FULL_TOTAL || fullTap.pass !== EXPECTED_FULL_TOTAL) {
      throw new EvidenceError("TEST_FACTS", `full.total must equal ${EXPECTED_FULL_TOTAL}`);
    }
    if (fullTap.total !== PRIOR_CUMULATIVE_TEST_TOTAL + evidenceTap.total) {
      throw new EvidenceError("TEST_FACTS", "full.total must equal 428 + evidenceVerifier.total");
    }
    if (JSON.stringify(manifest.testFacts.corrective4) !== JSON.stringify(focusedTap)) {
      throw new EvidenceError("TEST_FACTS", "corrective4 facts do not match TAP");
    }
    if (JSON.stringify(manifest.testFacts.evidenceVerifier) !== JSON.stringify(evidenceTap)) {
      throw new EvidenceError("TEST_FACTS", "evidenceVerifier facts do not match TAP");
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
    const audit = parseAuditReport(auditText);
    if (JSON.stringify(manifest.auditFacts) !== JSON.stringify(audit.facts)) {
      throw new EvidenceError("AUDIT", "auditFacts do not match independently derived audit");
    }

    const derivedSafety = deriveSafetyAttestations(
      repositoryRoot,
      logsByName.get("dry-run").stdout,
    );
    assertSafetyAllFalse(derivedSafety);
    if (JSON.stringify(derivedSafety) !== JSON.stringify(manifest.safety)) {
      throw new EvidenceError("SAFETY", "safety attestations do not match independent scans");
    }

    scanArtifactTree(artifactRoot);

    const canonicalRoot = path.resolve(repositoryRoot, ARTIFACT_DIR_REL);
    if (path.resolve(artifactRoot) === canonicalRoot) {
      independentlyRerunCriticalCommands(repositoryRoot, logsByName);
    }
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
