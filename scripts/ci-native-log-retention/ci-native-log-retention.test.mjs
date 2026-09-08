import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureIntegration,
  EXPECTED_TEST_TAP,
  finalizePacket,
  inspectWorkflow,
  NATIVE_COPY_REL,
  NATIVE_LOG_REL,
  parseTapCounts,
  RetentionError,
  retentionRootFromRepo,
  SHA256SUMS_REL,
  sha256,
  verifyPacket,
} from "./lib.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function validTap() {
  return [
    "1..13",
    "# tests 13",
    "# pass 13",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n");
}

function tempRoot(t) {
  const base = path.join(repoRoot, "artifacts", "ci-native-log-retention-selftest");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function gitHead(dir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function gitTree(dir) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
}

function initRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "README"), "ci-native-log-retention-test\n");
  execFileSync("git", ["add", "README"], { cwd: dir, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=ci@example.test", "-c", "user.name=ci", "commit", "-m", "init"],
    { cwd: dir, stdio: "ignore" },
  );
}

function writeStub(repo, { exitCode, nativeText, stdout, stderr, writeNative }) {
  const stub = path.join(repo, "stub.mjs");
  const nativeAbs = path.join(repo, NATIVE_LOG_REL);
  const source = `
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
if (${writeNative ? "true" : "false"}) {
  const native = ${JSON.stringify(nativeAbs)};
  mkdirSync(path.dirname(native), { recursive: true });
  writeFileSync(native, ${JSON.stringify(nativeText ?? "")});
}
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr ?? "child-stderr\\n")});
process.exit(${exitCode});
`;
  writeFileSync(stub, source);
  return stub;
}

function envFor(repo, packetId, extra = {}) {
  return {
    PATH: process.env.PATH,
    CI_NATIVE_LOG_PACKET_ID: packetId,
    GITHUB_REPOSITORY: "danny0971haha/multi-venue-grid-engine",
    SOURCE_HEAD: "4ead28400903ad6c62616835aa9459f67c6d8cd9",
    SOURCE_TREE: "3a10f7645b30a33f27ecde824c16e0e36cacae6c",
    GITHUB_WORKFLOW: "Phase 0 CI",
    GITHUB_RUN_ID: extra.runId ?? "test-run-1",
    GITHUB_JOB: "verify",
    GITHUB_JOB_DATABASE_ID: extra.jobDatabaseId ?? "UNKNOWN",
    GITHUB_RUN_ATTEMPT: extra.attempt ?? "1",
    HOME: repo,
    TMPDIR: repo,
    ...extra,
  };
}

function wrapperStdout(nativeText, childExit) {
  const report = {
    mode: "test",
    checks: [
      {
        command: [
          "node",
          "--test",
          "--test-reporter=tap",
          "test/offline-integration/integration.test.ts",
        ],
        exitCode: childExit,
        log: NATIVE_LOG_REL,
        logSha256: sha256(Buffer.from(nativeText)),
      },
    ],
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

test("workflow keeps original job name, pins, and always-run packet upload without masking", () => {
  const text = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.deepEqual(inspectWorkflow(text), []);
  assert.equal(text.includes("continue-on-error"), false);
  assert.equal(/\|\|\s*true/.test(text), false);
  assert.match(
    text,
    /node scripts\/ci-native-log-retention\/capture\.mjs -- npm run test:offline-integration/,
  );
});

test("successful capture copies native log bytes and records tested HEAD not SOURCE_HEAD", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 0,
    nativeText: tap,
    stdout: wrapperStdout(tap, 0),
    writeNative: true,
  });
  const packetId = "run-success";
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, packetId),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.verification.ok, true);
  const copy = readFileSync(path.join(result.packetRoot, NATIVE_COPY_REL));
  const original = readFileSync(path.join(repo, NATIVE_LOG_REL));
  assert.equal(copy.equals(original), true);
  assert.equal(copy.toString("utf8"), tap);
  const manifest = JSON.parse(
    readFileSync(path.join(result.packetRoot, "evidence-manifest.json"), "utf8"),
  );
  assert.equal(manifest.testedCheckoutSha, gitHead(repo));
  assert.equal(manifest.testedCheckoutTree, gitTree(repo));
  assert.notEqual(manifest.testedCheckoutSha, manifest.sourceHead);
  assert.equal(manifest.historicalOriginalLog, "NOT_OBTAINED");
  assert.equal(manifest.freshExecutionLog, "OBTAINED");
  assert.deepEqual(parseTapCounts(copy), EXPECTED_TEST_TAP);
  const sums = readFileSync(path.join(result.packetRoot, SHA256SUMS_REL), "utf8");
  assert.equal(sums.includes(SHA256SUMS_REL), false);
});

test("child command non-zero exit preserves failure output and does not become success", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 7,
    nativeText: tap,
    stdout: wrapperStdout(tap, 7),
    stderr: "child-failed\n",
    writeNative: true,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-nonzero"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.verification.ok, true);
  assert.match(
    readFileSync(path.join(result.packetRoot, "wrapper.stderr.log"), "utf8"),
    /child-failed/,
  );
  const capture = JSON.parse(
    readFileSync(path.join(result.packetRoot, "capture-result.json"), "utf8"),
  );
  assert.equal(capture.exitCode, 7);
  assert.equal(capture.integrationStatus, "RAN");
});

test("missing native log after successful child is verification failure and does not create a fake file", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  writeStub(repo, {
    exitCode: 0,
    nativeText: "",
    stdout: "{}\n",
    writeNative: false,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-missing"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.verification.ok, false);
  assert.equal(
    result.verification.errors.some((error) => error.startsWith("NATIVE_LOG_MISSING")),
    true,
  );
  assert.equal(existsSync(path.join(result.packetRoot, NATIVE_COPY_REL)), false);
  assert.equal(existsSync(path.join(repo, NATIVE_LOG_REL)), false);
});

test("log bytes that disagree with the manifest hash fail verification", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 0,
    nativeText: tap,
    stdout: wrapperStdout(tap, 0),
    writeNative: true,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-hash"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.equal(result.exitCode, 0);
  const nativePath = path.join(result.packetRoot, NATIVE_COPY_REL);
  writeFileSync(nativePath, `${tap}tampered\n`);
  const verified = verifyPacket(result.packetRoot, {
    expectedPacketId: "run-hash",
    expectedRunId: "test-run-1",
    expectedTestedSha: gitHead(repo),
  });
  assert.equal(verified.ok, false);
  assert.equal(
    verified.errors.some(
      (error) =>
        error.startsWith("SHA256_MISMATCH") || error === "NATIVE_LOG_MANIFEST_HASH_MISMATCH",
    ),
    true,
  );
});

test("upload-success analogue: packet verifies after child test failure", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 1,
    nativeText: tap,
    stdout: wrapperStdout(tap, 1),
    writeNative: true,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-upload-fail"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.verification.ok, true);
  const finalized = finalizePacket({
    repoRoot: repo,
    env: envFor(repo, "run-upload-fail"),
  });
  assert.equal(finalized.verification.ok, true);
  assert.equal(finalized.verification.integrationStatus, "RAN");
});

test("install/pre-step failure analogue records NOT_RUN without a fake native log", (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const env = envFor(repo, "run-notrun");
  const finalized = finalizePacket({ repoRoot: repo, env });
  assert.equal(finalized.verification.ok, true);
  assert.equal(finalized.verification.integrationStatus, "NOT_RUN");
  assert.equal(finalized.verification.freshExecutionLog, "NOT_RUN");
  assert.equal(existsSync(path.join(finalized.packetRoot, NATIVE_COPY_REL)), false);
  const capture = JSON.parse(
    readFileSync(path.join(finalized.packetRoot, "capture-result.json"), "utf8"),
  );
  assert.equal(capture.exitCode, "UNKNOWN");
  assert.equal(capture.signal, "UNKNOWN");
});

test("TAP missing totals fail parse", () => {
  assert.throws(
    () => parseTapCounts("# tests 13\n# pass 13\n"),
    (error) => {
      return (
        error instanceof RetentionError && error.code.startsWith("TAP_TOTAL_MISSING_OR_AMBIGUOUS:")
      );
    },
  );
});

test("TAP duplicate totals fail parse", () => {
  const text = `${validTap()}# tests 13\n`;
  assert.throws(
    () => parseTapCounts(text),
    (error) => {
      return (
        error instanceof RetentionError && error.code === "TAP_TOTAL_MISSING_OR_AMBIGUOUS:tests"
      );
    },
  );
});

test("TAP totals that are not the required 13/13 fail successful-run verification", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = [
    "1..12",
    "# tests 12",
    "# pass 12",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "",
  ].join("\n");
  writeStub(repo, {
    exitCode: 0,
    nativeText: tap,
    stdout: wrapperStdout(tap, 0),
    writeNative: true,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-tap-wrong"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.verification.ok, false);
  assert.equal(result.verification.errors.includes("EXACT_HISTORICAL_TEST_TOTAL_MISMATCH"), true);
});

test("old packet identity or wrong tested SHA is rejected", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 0,
    nativeText: tap,
    stdout: wrapperStdout(tap, 0),
    writeNative: true,
  });
  const result = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-stale", { runId: "old-run" }),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  assert.equal(result.exitCode, 0);
  const staleId = verifyPacket(result.packetRoot, {
    expectedPacketId: "run-current",
    expectedRunId: "old-run",
    expectedTestedSha: gitHead(repo),
  });
  assert.equal(staleId.ok, false);
  assert.equal(
    staleId.errors.some((error) => error.startsWith("STALE_PACKET")),
    true,
  );

  const wrongSha = verifyPacket(result.packetRoot, {
    expectedPacketId: "run-stale",
    expectedRunId: "old-run",
    expectedTestedSha: "4ead28400903ad6c62616835aa9459f67c6d8cd9",
  });
  assert.equal(wrongSha.ok, false);
  assert.equal(wrongSha.errors.includes("WRONG_TESTED_SHA"), true);

  writeFileSync(path.join(result.packetRoot, "foreign-old.log"), "old-packet\n");
  const undeclared = verifyPacket(result.packetRoot, {
    expectedPacketId: "run-stale",
    expectedRunId: "old-run",
    expectedTestedSha: gitHead(repo),
  });
  assert.equal(undeclared.ok, false);
  assert.equal(
    undeclared.errors.some((error) => error.startsWith("UNDECLARED_FILE")),
    true,
  );
});

test("finalize does not convert a captured packet into NOT_RUN", async (t) => {
  const repo = tempRoot(t);
  initRepo(repo);
  const tap = validTap();
  writeStub(repo, {
    exitCode: 0,
    nativeText: tap,
    stdout: wrapperStdout(tap, 0),
    writeNative: true,
  });
  const captured = await captureIntegration({
    repoRoot: repo,
    env: envFor(repo, "run-keep"),
    command: [process.execPath, path.join(repo, "stub.mjs")],
    mirror: false,
  });
  const finalized = finalizePacket({ repoRoot: repo, env: envFor(repo, "run-keep") });
  assert.equal(finalized.verification.ok, true);
  assert.equal(finalized.verification.integrationStatus, "RAN");
  assert.equal(existsSync(path.join(captured.packetRoot, NATIVE_COPY_REL)), true);
  assert.equal(path.dirname(finalized.packetRoot), retentionRootFromRepo(repo));
});
