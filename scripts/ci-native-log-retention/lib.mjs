import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const NATIVE_LOG_REL = "artifacts/offline-candidate/test/01.log";
export const NATIVE_COPY_REL = `native/${NATIVE_LOG_REL}`;
export const WRAPPER_STDOUT_REL = "wrapper.stdout.log";
export const WRAPPER_STDERR_REL = "wrapper.stderr.log";
export const IDENTITY_REL = "identity.json";
export const CAPTURE_RESULT_REL = "capture-result.json";
export const MANIFEST_REL = "evidence-manifest.json";
export const SHA256SUMS_REL = "SHA256SUMS";
export const EXPECTED_TEST_TAP = {
  tests: 13,
  pass: 13,
  fail: 0,
  cancelled: 0,
  skipped: 0,
  todo: 0,
};
export const TAP_KEYS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];
export const HISTORICAL_ORIGINAL_LOG = "NOT_OBTAINED";
export const DEFAULT_COMMAND = ["npm", "run", "test:offline-integration"];

const JSON_INDENT = 2;

export class RetentionError extends Error {
  /**
   * @param {string} code
   * @param {string} [detail]
   */
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "RetentionError";
    this.code = code;
    this.detail = detail;
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseCommand(argv) {
  const dash = argv.indexOf("--");
  if (dash === -1 || dash === argv.length - 1) {
    return [...DEFAULT_COMMAND];
  }
  return argv.slice(dash + 1);
}

export function posixRel(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new RetentionError("INVALID_PATH");
  }
  if (path.isAbsolute(value) || path.win32.parse(value).root !== "" || value.includes("\\")) {
    throw new RetentionError("ABSOLUTE_OR_NONCANONICAL_PATH");
  }
  if (value.split("/").some((part) => part === ".." || part === "." || part === "")) {
    throw new RetentionError("TRAVERSAL_OR_NONCANONICAL_PATH");
  }
  return value;
}

export function parseTapCounts(output) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : String(output);
  const result = {};
  for (const key of TAP_KEYS) {
    const values = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, "gm"))].map(
      (match) => match[1],
    );
    if (values.length !== 1) {
      throw new RetentionError(`TAP_TOTAL_MISSING_OR_AMBIGUOUS:${key}`);
    }
    result[key] = Number.parseInt(values[0], 10);
  }
  return result;
}

export function packetDir(retentionRoot, packetId) {
  if (
    typeof packetId !== "string" ||
    packetId.length === 0 ||
    packetId.includes("/") ||
    packetId.includes("\\") ||
    packetId.includes("..")
  ) {
    throw new RetentionError("INVALID_PACKET_ID");
  }
  return path.join(retentionRoot, packetId);
}

export function retentionRootFromRepo(repoRoot) {
  return path.join(repoRoot, "artifacts", "ci-native-log-retention");
}

function gitOutput(repoRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "UNKNOWN";
  }
}

export function observedGitIdentity(repoRoot) {
  return {
    testedCheckoutSha: gitOutput(repoRoot, ["rev-parse", "HEAD"]),
    testedCheckoutTree: gitOutput(repoRoot, ["rev-parse", "HEAD^{tree}"]),
  };
}

function envOrUnknown(env, key) {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : "UNKNOWN";
}

function writeJson(repoRoot, filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
  const biome = path.join(repoRoot, "node_modules", "@biomejs", "biome", "bin", "biome");
  if (existsSync(biome)) {
    execFileSync(process.execPath, [biome, "format", "--write", filePath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listRegularFiles(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${name.name}` : name.name;
      const abs = path.join(dir, name.name);
      if (name.isDirectory()) {
        walk(abs, nextRel);
        continue;
      }
      files.push(nextRel);
    }
  };
  if (existsSync(root)) {
    walk(root, "");
  }
  return files.sort();
}

function lstatRegular(absPath) {
  const st = lstatSync(absPath);
  if (st.isSymbolicLink()) {
    throw new RetentionError("SYMLINK");
  }
  if (!st.isFile()) {
    throw new RetentionError("NOT_REGULAR");
  }
  return st;
}

function fileRecord(absPath, rel) {
  lstatRegular(absPath);
  const bytes = readFileSync(absPath);
  return {
    path: posixRel(rel),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function copyNativeLog(repoRoot, packetRoot) {
  const source = path.join(repoRoot, NATIVE_LOG_REL);
  if (!existsSync(source)) {
    return { status: "NOT_OBTAINED", record: null };
  }
  lstatRegular(source);
  const destRel = NATIVE_COPY_REL;
  const dest = path.join(packetRoot, destRel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest, fsConstants.COPYFILE_EXCL);
  const sourceBytes = readFileSync(source);
  const destBytes = readFileSync(dest);
  if (!sourceBytes.equals(destBytes)) {
    throw new RetentionError("NATIVE_LOG_COPY_CHANGED_BYTES");
  }
  return {
    status: "OBTAINED",
    record: fileRecord(dest, destRel),
    sourceBytes: sourceBytes.length,
    sourceSha256: sha256(sourceBytes),
  };
}

function wrapperLogSha256(stdout) {
  try {
    const report = JSON.parse(stdout.toString("utf8"));
    const digest = report?.checks?.[0]?.logSha256;
    return typeof digest === "string" && digest.length > 0 ? digest : null;
  } catch {
    return null;
  }
}

async function runCommand(command, { cwd, env, mirror }) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(chunk);
    if (mirror) {
      process.stdout.write(chunk);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    if (mirror) {
      process.stderr.write(chunk);
    }
  });
  const close = await new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ kind: "spawn-error", error });
    });
    child.on("close", (code, signal) => {
      resolve({ kind: "close", code, signal });
    });
  });
  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  if (close.kind === "spawn-error") {
    return {
      exitCode: 127,
      signal: "UNKNOWN",
      stdout,
      stderr,
      spawnError: close.error instanceof Error ? close.error.message : String(close.error),
    };
  }
  return {
    exitCode: close.code === null ? "UNKNOWN" : close.code,
    signal: close.signal === null ? null : close.signal,
    stdout,
    stderr,
  };
}

function processExitStatus(observed) {
  if (observed.exitCode !== 0 && observed.exitCode !== "UNKNOWN") {
    return Number(observed.exitCode);
  }
  if (observed.exitCode === "UNKNOWN" || observed.signal) {
    return 1;
  }
  return 0;
}

function buildManifest({ env, repoRoot, command, observed, native, startedAtUtc, endedAtUtc }) {
  const git = observedGitIdentity(repoRoot);
  return {
    repository: envOrUnknown(env, "GITHUB_REPOSITORY"),
    sourceHead: envOrUnknown(env, "SOURCE_HEAD"),
    sourceTree: envOrUnknown(env, "SOURCE_TREE"),
    testedCheckoutSha: git.testedCheckoutSha,
    testedCheckoutTree: git.testedCheckoutTree,
    workflow: envOrUnknown(env, "GITHUB_WORKFLOW"),
    runId: envOrUnknown(env, "GITHUB_RUN_ID"),
    jobId: envOrUnknown(env, "GITHUB_JOB"),
    jobDatabaseId: envOrUnknown(env, "GITHUB_JOB_DATABASE_ID"),
    attempt: envOrUnknown(env, "GITHUB_RUN_ATTEMPT"),
    startedAtUtc,
    endedAtUtc,
    command,
    exitCode: observed.exitCode,
    signal: observed.signal === undefined ? "UNKNOWN" : observed.signal,
    historicalOriginalLog: HISTORICAL_ORIGINAL_LOG,
    freshExecutionLog: native.status,
    files: [],
  };
}

export function writeSha256Sums(packetRoot) {
  const lines = [];
  for (const rel of listRegularFiles(packetRoot)) {
    if (rel === SHA256SUMS_REL) {
      continue;
    }
    posixRel(rel);
    const abs = path.join(packetRoot, rel);
    const digest = sha256(readFileSync(abs));
    lines.push(`${digest}  ${rel}`);
  }
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  writeFileSync(path.join(packetRoot, SHA256SUMS_REL), body);
  return body;
}

function collectFileRecords(packetRoot) {
  const records = [];
  for (const rel of listRegularFiles(packetRoot)) {
    if (rel === SHA256SUMS_REL || rel === MANIFEST_REL) {
      continue;
    }
    records.push(fileRecord(path.join(packetRoot, rel), rel));
  }
  return records;
}

export function verifyPacket(packetRoot, options = {}) {
  const errors = [];
  const fail = (code, detail) => {
    errors.push(detail ? `${code}: ${detail}` : code);
  };

  if (!existsSync(packetRoot)) {
    return { ok: false, errors: ["PACKET_MISSING"], integrationStatus: "UNKNOWN" };
  }

  const identityPath = path.join(packetRoot, IDENTITY_REL);
  const capturePath = path.join(packetRoot, CAPTURE_RESULT_REL);
  const manifestPath = path.join(packetRoot, MANIFEST_REL);
  const sumsPath = path.join(packetRoot, SHA256SUMS_REL);
  if (
    !existsSync(identityPath) ||
    !existsSync(capturePath) ||
    !existsSync(manifestPath) ||
    !existsSync(sumsPath)
  ) {
    return { ok: false, errors: ["PACKET_INCOMPLETE"], integrationStatus: "UNKNOWN" };
  }

  const identity = readJson(identityPath);
  const capture = readJson(capturePath);
  const manifest = readJson(manifestPath);
  const sumsText = readFileSync(sumsPath, "utf8");

  if (identity.historicalOriginalLog !== HISTORICAL_ORIGINAL_LOG) {
    fail("HISTORICAL_ORIGINAL_LOG_ALTERED");
  }
  if (options.expectedPacketId && identity.packetId !== options.expectedPacketId) {
    fail("STALE_PACKET", "packetId");
  }
  if (options.expectedRunId && manifest.runId !== options.expectedRunId) {
    fail("STALE_PACKET", "runId");
  }
  if (options.expectedTestedSha && manifest.testedCheckoutSha !== options.expectedTestedSha) {
    fail("WRONG_TESTED_SHA");
  }
  if (manifest.testedCheckoutSha === manifest.sourceHead && options.rejectSourceHeadAsTested) {
    fail("SOURCE_HEAD_USED_AS_TESTED_SHA");
  }

  const listed = new Map();
  if (sumsText.length > 0) {
    for (const line of sumsText.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!match) {
        fail("SHA256SUMS_MALFORMED");
        continue;
      }
      const rel = match[2];
      if (rel === SHA256SUMS_REL) {
        fail("SHA256SUMS_INCLUDES_SELF");
        continue;
      }
      try {
        posixRel(rel);
      } catch (error) {
        fail(error instanceof RetentionError ? error.code : "INVALID_PATH");
        continue;
      }
      listed.set(rel, match[1]);
    }
  }

  const onDisk = listRegularFiles(packetRoot);
  for (const rel of onDisk) {
    if (rel === SHA256SUMS_REL) {
      continue;
    }
    if (!listed.has(rel)) {
      fail("UNDECLARED_FILE", rel);
    }
  }
  for (const [rel, digest] of listed) {
    const abs = path.join(packetRoot, rel);
    if (!existsSync(abs)) {
      fail("MISSING_FILE", rel);
      continue;
    }
    try {
      const actual = sha256(readFileSync(abs));
      if (actual !== digest) {
        fail("SHA256_MISMATCH", rel);
      }
    } catch (error) {
      fail(error instanceof RetentionError ? error.code : "READ_FAILED", rel);
    }
  }

  const nativeAbs = path.join(packetRoot, NATIVE_COPY_REL);
  const nativePresent = existsSync(nativeAbs);
  if (nativePresent) {
    try {
      lstatRegular(nativeAbs);
    } catch (error) {
      fail(error instanceof RetentionError ? error.code : "NATIVE_LOG_INVALID");
    }
    const nativeBytes = existsSync(nativeAbs) ? readFileSync(nativeAbs) : Buffer.alloc(0);
    const nativeRecord = manifest.files.find((entry) => entry.path === NATIVE_COPY_REL);
    if (!nativeRecord) {
      fail("NATIVE_LOG_NOT_IN_MANIFEST");
    } else if (
      nativeRecord.sha256 !== sha256(nativeBytes) ||
      nativeRecord.bytes !== nativeBytes.length
    ) {
      fail("NATIVE_LOG_MANIFEST_HASH_MISMATCH");
    }
  }

  const integrationStatus = capture.integrationStatus;
  const expectedNative =
    integrationStatus === "RAN" && (capture.exitCode === 0 || options.requireNativeLog === true);
  if (expectedNative && !nativePresent) {
    fail("NATIVE_LOG_MISSING");
    if (existsSync(nativeAbs) && lstatSync(nativeAbs).size === 0 && options.treatEmptyAsFake) {
      fail("FAKE_EMPTY_NATIVE_LOG");
    }
  }
  if (integrationStatus === "NOT_RUN" && nativePresent) {
    fail("NATIVE_LOG_PRESENT_FOR_NOT_RUN");
  }
  if (
    integrationStatus === "NOT_RUN" &&
    (capture.exitCode !== "UNKNOWN" || capture.signal !== "UNKNOWN")
  ) {
    fail("NOT_RUN_MUST_USE_UNKNOWN_EXIT");
  }

  if (nativePresent && integrationStatus === "RAN" && capture.exitCode === 0) {
    try {
      const tap = parseTapCounts(readFileSync(nativeAbs));
      if (
        tap.tests !== EXPECTED_TEST_TAP.tests ||
        tap.pass !== EXPECTED_TEST_TAP.pass ||
        tap.fail !== EXPECTED_TEST_TAP.fail ||
        tap.cancelled !== EXPECTED_TEST_TAP.cancelled ||
        tap.skipped !== EXPECTED_TEST_TAP.skipped ||
        tap.todo !== EXPECTED_TEST_TAP.todo
      ) {
        fail("EXACT_HISTORICAL_TEST_TOTAL_MISMATCH");
      }
    } catch (error) {
      fail(error instanceof RetentionError ? error.code : "TAP_PARSE_FAILED");
    }
  }

  const stdoutAbs = path.join(packetRoot, WRAPPER_STDOUT_REL);
  if (existsSync(stdoutAbs) && nativePresent) {
    const reported = wrapperLogSha256(readFileSync(stdoutAbs));
    if (reported) {
      const actual = sha256(readFileSync(nativeAbs));
      if (reported !== actual) {
        fail("WRAPPER_LOGSHA256_MISMATCH");
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    integrationStatus,
    freshExecutionLog: manifest.freshExecutionLog ?? capture.freshExecutionLog ?? "UNKNOWN",
    historicalOriginalLog: identity.historicalOriginalLog,
    testedCheckoutSha: manifest.testedCheckoutSha,
    runId: manifest.runId,
  };
}

export function writeNotRunPacket({ repoRoot, packetRoot, packetId, env, intendedCommand }) {
  mkdirSync(packetRoot, { recursive: true });
  const git = observedGitIdentity(repoRoot);
  const now = new Date().toISOString();
  writeJson(repoRoot, path.join(packetRoot, IDENTITY_REL), {
    packetId,
    createdAtUtc: now,
    historicalOriginalLog: HISTORICAL_ORIGINAL_LOG,
  });
  writeJson(repoRoot, path.join(packetRoot, CAPTURE_RESULT_REL), {
    integrationStatus: "NOT_RUN",
    command: intendedCommand ?? [...DEFAULT_COMMAND],
    exitCode: "UNKNOWN",
    signal: "UNKNOWN",
    startedAtUtc: now,
    endedAtUtc: now,
    freshExecutionLog: "NOT_RUN",
  });
  writeJson(repoRoot, path.join(packetRoot, MANIFEST_REL), {
    repository: envOrUnknown(env, "GITHUB_REPOSITORY"),
    sourceHead: envOrUnknown(env, "SOURCE_HEAD"),
    sourceTree: envOrUnknown(env, "SOURCE_TREE"),
    testedCheckoutSha: git.testedCheckoutSha,
    testedCheckoutTree: git.testedCheckoutTree,
    workflow: envOrUnknown(env, "GITHUB_WORKFLOW"),
    runId: envOrUnknown(env, "GITHUB_RUN_ID"),
    jobId: envOrUnknown(env, "GITHUB_JOB"),
    jobDatabaseId: envOrUnknown(env, "GITHUB_JOB_DATABASE_ID"),
    attempt: envOrUnknown(env, "GITHUB_RUN_ATTEMPT"),
    startedAtUtc: now,
    endedAtUtc: now,
    command: intendedCommand ?? [...DEFAULT_COMMAND],
    exitCode: "UNKNOWN",
    signal: "UNKNOWN",
    historicalOriginalLog: HISTORICAL_ORIGINAL_LOG,
    freshExecutionLog: "NOT_RUN",
    files: [],
  });
  const manifest = readJson(path.join(packetRoot, MANIFEST_REL));
  manifest.files = collectFileRecords(packetRoot);
  writeJson(repoRoot, path.join(packetRoot, MANIFEST_REL), manifest);
  writeSha256Sums(packetRoot);
}

export async function captureIntegration({
  repoRoot,
  env,
  command,
  mirror = false,
  now = () => new Date().toISOString(),
}) {
  const packetId = envOrUnknown(env, "CI_NATIVE_LOG_PACKET_ID");
  if (packetId === "UNKNOWN") {
    throw new RetentionError("MISSING_PACKET_ID");
  }
  const retentionRoot = retentionRootFromRepo(repoRoot);
  const packetRoot = packetDir(retentionRoot, packetId);
  if (existsSync(packetRoot)) {
    throw new RetentionError("PACKET_DIR_EXISTS");
  }
  mkdirSync(packetRoot, { recursive: true });
  const startedAtUtc = now();
  writeJson(repoRoot, path.join(packetRoot, IDENTITY_REL), {
    packetId,
    createdAtUtc: startedAtUtc,
    historicalOriginalLog: HISTORICAL_ORIGINAL_LOG,
  });

  const observed = await runCommand(command, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    mirror,
  });
  writeFileSync(path.join(packetRoot, WRAPPER_STDOUT_REL), observed.stdout);
  writeFileSync(path.join(packetRoot, WRAPPER_STDERR_REL), observed.stderr);

  let native;
  try {
    native = copyNativeLog(repoRoot, packetRoot);
  } catch (error) {
    native = {
      status: "NOT_OBTAINED",
      record: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const endedAtUtc = now();
  writeJson(repoRoot, path.join(packetRoot, CAPTURE_RESULT_REL), {
    integrationStatus: "RAN",
    command,
    exitCode: observed.exitCode,
    signal: observed.signal === undefined ? "UNKNOWN" : observed.signal,
    spawnError: observed.spawnError ?? null,
    startedAtUtc,
    endedAtUtc,
    freshExecutionLog: native.status,
    nativeCopyError: native.error ?? null,
  });

  const manifest = buildManifest({
    env,
    repoRoot,
    command,
    observed,
    native,
    startedAtUtc,
    endedAtUtc,
  });
  writeJson(repoRoot, path.join(packetRoot, MANIFEST_REL), manifest);
  manifest.files = collectFileRecords(packetRoot);
  writeJson(repoRoot, path.join(packetRoot, MANIFEST_REL), manifest);
  writeSha256Sums(packetRoot);

  const verification = verifyPacket(packetRoot, {
    expectedPacketId: packetId,
    expectedRunId: envOrUnknown(env, "GITHUB_RUN_ID"),
    expectedTestedSha: observedGitIdentity(repoRoot).testedCheckoutSha,
    requireNativeLog: observed.exitCode === 0,
  });

  const childStatus = processExitStatus(observed);
  const exitCode = childStatus !== 0 ? childStatus : verification.ok ? 0 : 1;
  return {
    packetRoot,
    packetId,
    exitCode,
    verification,
    observed,
    nativeStatus: native.status,
  };
}

export function finalizePacket({ repoRoot, env, intendedCommand }) {
  const packetId = envOrUnknown(env, "CI_NATIVE_LOG_PACKET_ID");
  if (packetId === "UNKNOWN") {
    throw new RetentionError("MISSING_PACKET_ID");
  }
  const retentionRoot = retentionRootFromRepo(repoRoot);
  const packetRoot = packetDir(retentionRoot, packetId);
  const capturePath = path.join(packetRoot, CAPTURE_RESULT_REL);

  if (!existsSync(capturePath)) {
    const started =
      existsSync(path.join(packetRoot, IDENTITY_REL)) ||
      existsSync(path.join(packetRoot, WRAPPER_STDOUT_REL)) ||
      existsSync(path.join(packetRoot, WRAPPER_STDERR_REL)) ||
      existsSync(path.join(packetRoot, NATIVE_COPY_REL));
    if (started) {
      writeJson(repoRoot, path.join(packetRoot, CAPTURE_RESULT_REL), {
        integrationStatus: "RAN",
        command: intendedCommand ?? [...DEFAULT_COMMAND],
        exitCode: "UNKNOWN",
        signal: "UNKNOWN",
        startedAtUtc: "UNKNOWN",
        endedAtUtc: new Date().toISOString(),
        freshExecutionLog: existsSync(path.join(packetRoot, NATIVE_COPY_REL))
          ? "OBTAINED"
          : "NOT_OBTAINED",
        incompleteCapture: true,
      });
    } else {
      writeNotRunPacket({
        repoRoot,
        packetRoot,
        packetId,
        env,
        intendedCommand: intendedCommand ?? [...DEFAULT_COMMAND],
      });
    }
  } else {
    const identity = readJson(path.join(packetRoot, IDENTITY_REL));
    if (identity.packetId !== packetId) {
      throw new RetentionError("STALE_PACKET", "packetId");
    }
    const manifestPath = path.join(packetRoot, MANIFEST_REL);
    if (existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      manifest.files = collectFileRecords(packetRoot);
      writeJson(repoRoot, manifestPath, manifest);
    }
    writeSha256Sums(packetRoot);
  }

  const git = observedGitIdentity(repoRoot);
  const verification = verifyPacket(packetRoot, {
    expectedPacketId: packetId,
    expectedRunId: envOrUnknown(env, "GITHUB_RUN_ID"),
    expectedTestedSha: git.testedCheckoutSha === "UNKNOWN" ? undefined : git.testedCheckoutSha,
  });
  return { packetRoot, packetId, verification };
}

export function inspectWorkflow(text) {
  const findings = [];
  if (!text.includes("name: Clean install, static checks, tests, secret scan, and dry-run")) {
    findings.push("JOB_NAME_CHANGED");
  }
  if (!text.includes("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1")) {
    findings.push("CHECKOUT_PIN_CHANGED");
  }
  if (!text.includes("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020")) {
    findings.push("SETUP_NODE_PIN_CHANGED");
  }
  if (!text.includes("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")) {
    findings.push("UPLOAD_PIN_CHANGED");
  }
  if (!text.includes("path: artifacts/phase2d-corrective4/")) {
    findings.push("EXISTING_UPLOAD_PATH_CHANGED");
  }
  if (!text.includes("npm run test:offline-integration")) {
    findings.push("OFFLINE_INTEGRATION_COMMAND_MISSING");
  }
  if (/\|\|\s*true/.test(text)) {
    findings.push("PIPE_TRUE_MASKING");
  }
  if (/continue-on-error\s*:/.test(text)) {
    findings.push("CONTINUE_ON_ERROR");
  }
  const finalizeHasAlways = /name: Finalize CI native log packet\n\s+if: always\(\)/.test(text);
  const uploadHasAlways = /name: Upload CI native log packet\n\s+if: always\(\)/.test(text);
  if (!finalizeHasAlways) {
    findings.push("FINALIZE_MISSING_ALWAYS");
  }
  if (!uploadHasAlways) {
    findings.push("UPLOAD_PACKET_MISSING_ALWAYS");
  }
  return findings;
}
