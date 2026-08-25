import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifierPath = path.join(repositoryRoot, "scripts/evidence/phase2d-corrective4-verify.mjs");
const verifyLibPath = path.join(
  repositoryRoot,
  "scripts/evidence/phase2d-corrective4-verify-lib.mjs",
);
const generatorLibPath = path.join(repositoryRoot, "scripts/evidence/phase2d-corrective4-lib.mjs");
const corrective4Path = path.join(repositoryRoot, "test/risk/risk-engine-corrective-4.test.ts");
const handwrittenAssemblerPath = path.join(
  repositoryRoot,
  "test/evidence/fixtures/handwritten-intact.mjs",
);
const packageScriptAssertPath = path.join(
  repositoryRoot,
  "test/evidence/fixtures/assert-package-scripts.mjs",
);
const zeroAuditCheckPath = path.join(repositoryRoot, "test/evidence/fixtures/check-zero-audit.mjs");

const EVIDENCE_TEST_REL = "test/evidence/phase2d-corrective4-evidence.test.ts";
const EVIDENCE_VERIFIER_TOTAL = 46;
const EXPECTED_FULL_TOTAL = 474;
const PRIOR_CUMULATIVE_TEST_TOTAL = 428;

function renderTap(
  total: number,
  pass: number,
  fail = 0,
  skip = 0,
  todo = 0,
  cancelled = 0,
): string {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
}

function strippedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GITHUB_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function verify(directory: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [verifierPath, directory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: strippedEnv(env),
  });
}

function readManifest(directory: string): Record<string, unknown> & {
  identity: Record<string, string>;
  commands: Array<{
    name: string;
    stdoutFile: string;
    stdoutSha256: string;
    exitCode: number;
    startedAt: string;
    completedAt: string;
  }>;
  testFacts: {
    full: Record<string, number>;
    evidenceVerifier: Record<string, number>;
    corrective4: Record<string, number>;
  };
  auditFacts: Record<string, unknown>;
  fileCommitment: { files: Array<{ path: string; sha256: string }> };
  testFileInventory: { files: Array<{ path: string; sha256: string; suite: string }> };
} {
  return JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
}

function writeManifest(directory: string, manifest: unknown): void {
  writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function copyFixture(intactDir: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "p2d-c4-tamper-"));
  cpSync(intactDir, directory, { recursive: true });
  return directory;
}

function rewriteStdout(directory: string, commandName: string, stdout: string): void {
  const manifest = readManifest(directory);
  const command = manifest.commands.find((entry) => entry.name === commandName);
  assert.ok(command);
  writeFileSync(path.join(directory, command.stdoutFile), stdout);
  command.stdoutSha256 = sha256(stdout);
  writeManifest(directory, manifest);
}

function rewriteAudit(directory: string, stdout: string): void {
  rewriteStdout(directory, "audit", stdout);
  writeFileSync(path.join(directory, "audit.json"), stdout);
}

function firstCommand(manifest: ReturnType<typeof readManifest>) {
  const command = manifest.commands[0];
  assert.ok(command);
  return command;
}

function firstFile(manifest: ReturnType<typeof readManifest>) {
  const entry = manifest.fileCommitment.files[0];
  assert.ok(entry);
  return entry;
}

function assertFailureCode(
  result: ReturnType<typeof verify>,
  directory: string,
  code: string,
): void {
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const verifierResult = JSON.parse(readFileSync(path.join(directory, "verifier.json"), "utf8"));
  assert.equal(verifierResult.integrityOk, false);
  assert.equal(verifierResult.gateStatus, "NOT_EMITTED");
  assert.equal(verifierResult.independentReview, "NOT_PERFORMED");
  const matched = verifierResult.issues.some((issue: string) => issue.startsWith(`${code}:`));
  assert.equal(matched, true, `expected ${code} in ${JSON.stringify(verifierResult.issues)}`);
  assert.match(result.stderr, new RegExp(`${code}:`));
}

function pushEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: "push",
    GITHUB_SHA: git(["rev-parse", "HEAD"]),
    GITHUB_REF_NAME: "experiment/v0.1-phase2",
    GITHUB_RUN_ID: "12345",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "verify",
    ...overrides,
  };
}

function applyPushIdentity(manifest: ReturnType<typeof readManifest>): void {
  manifest.identity.githubEventName = "push";
  manifest.identity.sourceBranch = "experiment/v0.1-phase2";
  manifest.identity.githubRunId = "12345";
  manifest.identity.githubRunAttempt = "1";
  manifest.identity.githubJob = "verify";
}

function auditDocument(
  metadata: Record<string, number>,
  vulnerabilities: Record<string, unknown> = {},
): string {
  return `${JSON.stringify(
    {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: metadata },
    },
    null,
    2,
  )}\n`;
}

describe("Phase 2D Corrective 4 evidence verifier", { concurrency: 1 }, () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "p2d-c4-evidence-"));
  const intactDir = path.join(tempRoot, "intact");
  const copies: string[] = [];

  before(() => {
    const assembled = spawnSync(process.execPath, [handwrittenAssemblerPath, intactDir], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(assembled.status, 0, assembled.stderr || assembled.stdout);
  });

  after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    for (const directory of copies) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function tamper() {
    const directory = copyFixture(intactDir);
    copies.push(directory);
    return directory;
  }

  test("E4-00 Corrective 4 focused suite still has 15 named tests and no skips", () => {
    const source = readFileSync(corrective4Path, "utf8");
    const names = [...source.matchAll(/test\("(C4-\d+)/g)].map((match) => match[1]);
    assert.deepEqual(
      names,
      Array.from({ length: 15 }, (_, index) => `C4-${String(index + 1).padStart(2, "0")}`),
    );
    assert.equal(/test\.(?:skip|todo)\(/.test(source), false);
    assert.equal(/describe\.(?:skip|todo)\(/.test(source), false);
  });

  test("E4-01 handwritten intact fixture verifies without a gate verdict", () => {
    const directory = tamper();
    const result = verify(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gateStatus=NOT_EMITTED/);
    assert.match(result.stdout, /integrityOk=true/);
    assert.match(result.stdout, /independentReview=NOT_PERFORMED/);
    assert.equal(result.stdout.includes("ACCEPT"), false);
    assert.equal(result.stdout.includes("PASS"), false);
    const verifierResult = JSON.parse(readFileSync(path.join(directory, "verifier.json"), "utf8"));
    assert.equal(verifierResult.integrityOk, true);
    assert.equal(verifierResult.gateStatus, "NOT_EMITTED");
    assert.equal(verifierResult.independentReview, "NOT_PERFORMED");
  });

  test("E4-02 sourceHeadSha impersonated by merge checkout fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const mergeSha = git(["log", "--merges", "-1", "--format=%H"]) || git(["rev-parse", "HEAD^"]);
    const liveHead = git(["rev-parse", "HEAD"]);
    const eventPath = path.join(directory, "event.json");
    writeFileSync(
      eventPath,
      `${JSON.stringify({
        pull_request: {
          head: { sha: liveHead, ref: "experiment/v0.1-phase2" },
          base: { sha: "057732cee021889d17573425ee4f24e2065df1e9" },
        },
      })}\n`,
    );
    manifest.identity.githubEventName = "pull_request";
    manifest.identity.sourceHeadSha = mergeSha;
    manifest.identity.sourceHeadTreeSha = git(["rev-parse", `${mergeSha}^{tree}`]);
    manifest.identity.githubRunId = "1";
    manifest.identity.githubRunAttempt = "1";
    manifest.identity.githubJob = "verify";
    writeManifest(directory, manifest);
    const result = verify(directory, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: mergeSha,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "verify",
    });
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("E4-03 tampered tree SHA fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const otherTree = git(["rev-parse", "HEAD^{tree}"]);
    const parentTree = git(["rev-parse", "HEAD~1^{tree}"]);
    manifest.identity.sourceHeadTreeSha = parentTree === otherTree ? "0".repeat(40) : parentTree;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("E4-04 tampered base SHA fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.identity.baseSha = git(["rev-parse", "HEAD"]);
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("E4-05 tampered command exit code fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    firstCommand(manifest).exitCode = 1;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "COMMAND");
  });

  test("E4-06 tampered raw log content fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const command = firstCommand(manifest);
    const stdoutPath = path.join(directory, command.stdoutFile);
    writeFileSync(stdoutPath, `${readFileSync(stdoutPath, "utf8")}tampered\n`);
    const result = verify(directory);
    assertFailureCode(result, directory, "COMMAND");
  });

  test("E4-07 tampered raw log hash fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    firstCommand(manifest).stdoutSha256 = "0".repeat(64);
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "COMMAND");
  });

  test("E4-08 tampered full test total fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFacts.full.total = 999;
    manifest.testFacts.full.pass = 999;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "TEST_FACTS");
  });

  test("E4-09 tampered fail/skip/todo counts fail closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFacts.full.fail = 1;
    manifest.testFacts.full.skip = 1;
    manifest.testFacts.full.todo = 1;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "TEST_FACTS");
  });

  test("E4-10 tampered file hash fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    firstFile(manifest).sha256 = "0".repeat(64);
    writeManifest(directory, manifest);
    writeFileSync(
      path.join(directory, "file-hashes.json"),
      `${JSON.stringify(manifest.fileCommitment, null, 2)}\n`,
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "FILE_HASH");
  });

  test("E4-11 missing required field fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    delete manifest.identity.generatedAt;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "SCHEMA");
  });

  test("E4-12 extra unauthorized field fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.extra = "unauthorized";
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "SCHEMA");
  });

  test("E4-13 absolute path in artifact fails closed", () => {
    const directory = tamper();
    const planted = path.join(path.sep, "Users", "apple", "multi-venue-grid-engine-starter");
    rewriteStdout(directory, "lint", `lint ${planted}\n`);
    const result = verify(directory);
    assertFailureCode(result, directory, "PATH");
  });

  test("E4-14 secret-like value in artifact fails closed", () => {
    const directory = tamper();
    const planted = `ghp_${"a".repeat(36)}`;
    rewriteStdout(directory, "lint", `lint ${planted}\n`);
    const result = verify(directory);
    assertFailureCode(result, directory, "SECRET");
  });

  test("E4-15 missing audit JSON fails closed", () => {
    const directory = tamper();
    rmSync(path.join(directory, "audit.json"));
    const result = verify(directory);
    assertFailureCode(result, directory, "ARTIFACT");
  });

  test("E4-16 unparseable audit JSON fails closed", () => {
    const directory = tamper();
    rewriteAudit(directory, "not-json\n");
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("E4-17 audit JSON with critical vulnerability fails closed", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument(
        { info: 0, low: 0, moderate: 0, high: 0, critical: 1, total: 1 },
        { evil: { name: "evil", severity: "critical" } },
      ),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("E4-18 generator self-declared gate verdict fails closed", () => {
    const directory = tamper();
    rewriteStdout(
      directory,
      "lint",
      '{"requestedVerdict":"ACCEPT","PHASE_2D_CORRECTIVE_4":"PASS"}\n',
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "GATE_VERDICT");
  });

  test("I-01 push sourceHeadSha does not equal GITHUB_SHA", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv({ GITHUB_SHA: git(["rev-parse", "HEAD~1"]) }));
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("I-02 push testedCheckoutSha does not equal GITHUB_SHA", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    const other = git(["rev-parse", "HEAD~1"]);
    manifest.identity.testedCheckoutSha = other;
    manifest.identity.testedCheckoutTreeSha = git(["rev-parse", `${other}^{tree}`]);
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv());
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("I-03 push sourceBranch does not equal GITHUB_REF_NAME", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv({ GITHUB_REF_NAME: "not-the-source-branch" }));
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("I-04 implementation base is not a source HEAD ancestor", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.identity.implementationBaseSha = "a".repeat(40);
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("I-05 PR source HEAD is not a tested merge ancestor", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const treeSha = git(["rev-parse", "HEAD^{tree}"]);
    const liveHead = git(["rev-parse", "HEAD"]);
    const eventPath = path.join(directory, "event.json");
    writeFileSync(
      eventPath,
      `${JSON.stringify({
        pull_request: {
          head: { sha: treeSha, ref: "experiment/v0.1-phase2" },
          base: { sha: "057732cee021889d17573425ee4f24e2065df1e9" },
        },
      })}\n`,
    );
    manifest.identity.githubEventName = "pull_request";
    manifest.identity.sourceHeadSha = treeSha;
    manifest.identity.sourceHeadTreeSha = treeSha;
    manifest.identity.sourceBranch = "experiment/v0.1-phase2";
    manifest.identity.baseSha = "057732cee021889d17573425ee4f24e2065df1e9";
    manifest.identity.githubRunId = "8";
    manifest.identity.githubRunAttempt = "1";
    manifest.identity.githubJob = "verify";
    writeManifest(directory, manifest);
    const result = verify(directory, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: liveHead,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_RUN_ID: "8",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "verify",
    });
    assertFailureCode(result, directory, "IDENTITY");
  });

  test("I-06 githubRunId is tampered", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    manifest.identity.githubRunId = "99999";
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv());
    assertFailureCode(result, directory, "CI_IDENTITY");
  });

  test("I-07 githubRunAttempt is tampered", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    manifest.identity.githubRunAttempt = "9";
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv());
    assertFailureCode(result, directory, "CI_IDENTITY");
  });

  test("I-08 githubJob is tampered", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    applyPushIdentity(manifest);
    manifest.identity.githubJob = "other-job";
    writeManifest(directory, manifest);
    const result = verify(directory, pushEnv());
    assertFailureCode(result, directory, "CI_IDENTITY");
  });

  test("I-09 malformed SHA or tree SHA fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.identity.sourceHeadSha = "NOTAVALIDSHA";
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "SHA");
  });

  test("I-10 invalid NaN or inverted timestamps fail closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const command = firstCommand(manifest);
    command.startedAt = "2026-08-25T12:00:00.000Z";
    command.completedAt = "2026-08-25T11:00:00.000Z";
    writeManifest(directory, manifest);
    const inverted = verify(directory);
    assertFailureCode(inverted, directory, "TIMESTAMP");

    const nanDir = tamper();
    const nanManifest = readManifest(nanDir);
    firstCommand(nanManifest).startedAt = "not-a-timestamp";
    writeManifest(nanDir, nanManifest);
    assertFailureCode(verify(nanDir), nanDir, "TIMESTAMP");
  });

  test("T-01 full total 428 with evidence suite removed is rejected", () => {
    const scriptResult = spawnSync(
      process.execPath,
      [packageScriptAssertPath, "removed-evidence"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    assert.equal(scriptResult.status, 2, scriptResult.stderr || scriptResult.stdout);
    assert.equal(scriptResult.stdout.trim(), "PACKAGE_SCRIPT");
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFacts.full = {
      total: PRIOR_CUMULATIVE_TEST_TOTAL,
      pass: PRIOR_CUMULATIVE_TEST_TOTAL,
      fail: 0,
      skip: 0,
      todo: 0,
      cancelled: 0,
    };
    writeManifest(directory, manifest);
    rewriteStdout(
      directory,
      "test",
      renderTap(PRIOR_CUMULATIVE_TEST_TOTAL, PRIOR_CUMULATIVE_TEST_TOTAL),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "TEST_FACTS");
  });

  test("T-02 package.json npm test rewritten to synthetic TAP is rejected", () => {
    const scriptResult = spawnSync(process.execPath, [packageScriptAssertPath, "synthetic-tap"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(scriptResult.status, 2, scriptResult.stderr || scriptResult.stdout);
    assert.equal(scriptResult.stdout.trim(), "PACKAGE_SCRIPT");
  });

  test("T-03 evidence test file omitted from full inventory is rejected", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFileInventory.files = manifest.testFileInventory.files.filter(
      (entry) => entry.path !== EVIDENCE_TEST_REL,
    );
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "INVENTORY");
  });

  test("T-04 dedicated evidence suite skip or todo is rejected", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const skipTotal = EVIDENCE_VERIFIER_TOTAL;
    manifest.testFacts.evidenceVerifier = {
      total: skipTotal,
      pass: skipTotal - 1,
      fail: 0,
      skip: 1,
      todo: 0,
      cancelled: 0,
    };
    writeManifest(directory, manifest);
    rewriteStdout(
      directory,
      "test:evidence:phase2d-corrective4",
      renderTap(skipTotal, skipTotal - 1, 0, 1, 0, 0),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "TEST_FACTS");
  });

  test("T-05 duplicate test-file path is rejected", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const first = manifest.testFileInventory.files[0];
    assert.ok(first);
    manifest.testFileInventory.files.push({ ...first });
    writeManifest(directory, manifest);
    const result = verify(directory);
    assertFailureCode(result, directory, "INVENTORY");
  });

  test("T-06 full.total does not equal 428 plus evidenceVerifier.total", () => {
    const directory = tamper();
    const wrong = EXPECTED_FULL_TOTAL + 1;
    const manifest = readManifest(directory);
    manifest.testFacts.full = {
      total: wrong,
      pass: wrong,
      fail: 0,
      skip: 0,
      todo: 0,
      cancelled: 0,
    };
    writeManifest(directory, manifest);
    rewriteStdout(directory, "test", renderTap(wrong, wrong));
    const result = verify(directory);
    assertFailureCode(result, directory, "TEST_FACTS");
  });

  test("A-01 high=1 critical=0 total=1 is rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument(
        { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
        { leftpad: { name: "leftpad", severity: "high" } },
      ),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-02 metadata total=0 with a high row is rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument(
        { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        { leftpad: { name: "leftpad", severity: "high" } },
      ),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-03 metadata total disagrees with severity sum", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 4 }),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-04 negative count is rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument({ info: 0, low: 0, moderate: 0, high: -1, critical: 0, total: -1 }),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-05 fractional count is rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument({ info: 0, low: 0, moderate: 0, high: 0.5, critical: 0, total: 0.5 }),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-06 unknown severity is rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      auditDocument(
        { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        { weird: { name: "weird", severity: "extreme" } },
      ),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-07 vulnerabilities that are not a plain object are rejected", () => {
    const directory = tamper();
    rewriteAudit(
      directory,
      `${JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities: [],
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        },
      })}\n`,
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "AUDIT");
  });

  test("A-08 real zero-audit artifact has integrityOk without a gate verdict", () => {
    const derived = spawnSync(process.execPath, [zeroAuditCheckPath], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    assert.equal(derived.status, 0, derived.stderr || derived.stdout);
    assert.match(derived.stdout, /AUDIT_ZERO=true/);
    const directory = tamper();
    const result = verify(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /integrityOk=true/);
    assert.match(result.stdout, /gateStatus=NOT_EMITTED/);
    assert.equal(result.stdout.includes("PASS"), false);
    assert.equal(result.stdout.includes("ACCEPT"), false);
  });

  test("V-01 generator last-wins TAP still fails verifier duplicate detection", () => {
    const directory = tamper();
    const generatorLib = readFileSync(generatorLibPath, "utf8");
    assert.match(generatorLib, /let tests;/);
    assert.equal(generatorLib.includes("duplicate TAP summary"), false);
    const verifyLib = readFileSync(verifyLibPath, "utf8");
    assert.match(verifyLib, /duplicate TAP summary/);
    rewriteStdout(
      directory,
      "test:phase2d-corrective-4",
      [
        "TAP version 13",
        "ok 1 - handwritten 1",
        "1..15",
        "# tests 99",
        "# pass 15",
        "# fail 0",
        "# cancelled 0",
        "# skipped 0",
        "# todo 0",
        "# tests 15",
        "",
      ].join("\n"),
    );
    const result = verify(directory);
    assertFailureCode(result, directory, "TAP");
  });

  test("V-02 verifier must not import generator semantic library", () => {
    const entry = readFileSync(verifierPath, "utf8");
    const verifyLib = readFileSync(verifyLibPath, "utf8");
    assert.equal(entry.includes("phase2d-corrective4-lib.mjs"), false);
    assert.equal(verifyLib.includes("phase2d-corrective4-lib.mjs"), false);
    assert.equal(entry.includes("generateEvidence"), false);
    assert.equal(verifyLib.includes("generateEvidence"), false);
    assert.equal(entry.includes("writeSyntheticArtifact"), false);
    assert.equal(verifyLib.includes("writeSyntheticArtifact"), false);
    assert.match(entry, /phase2d-corrective4-verify-lib\.mjs/);
    assert.match(entry, /phase2d-corrective4-schema\.mjs/);
    const relativeImports = [...entry.matchAll(/from ["'](\.[^"']+)["']/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(relativeImports.sort(), [
      "./phase2d-corrective4-schema.mjs",
      "./phase2d-corrective4-verify-lib.mjs",
    ]);
  });

  test("V-03 artifact containing self-declared ACCEPT is rejected", () => {
    const directory = tamper();
    rewriteStdout(directory, "lint", '{"selfDeclaredPass":true,"requestedDecision":"ACCEPT"}\n');
    const result = verify(directory);
    assertFailureCode(result, directory, "GATE_VERDICT");
  });
});
