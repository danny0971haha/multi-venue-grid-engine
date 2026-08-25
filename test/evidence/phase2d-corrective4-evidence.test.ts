import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const writeFixturePath = path.join(
  repositoryRoot,
  "scripts/evidence/phase2d-corrective4-write-fixture.mjs",
);
const verifierPath = path.join(repositoryRoot, "scripts/evidence/phase2d-corrective4-verify.mjs");
const corrective4Path = path.join(repositoryRoot, "test/risk/risk-engine-corrective-4.test.ts");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(args: string[]): string {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).stdout.trim();
}

function writeFixture(directory: string): void {
  const result = spawnSync(process.execPath, [writeFixturePath, directory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function verify(directory: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [verifierPath, directory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function readManifest(directory: string): Record<string, unknown> & {
  identity: Record<string, string>;
  commands: Array<{ name: string; stdoutFile: string; stdoutSha256: string; exitCode: number }>;
  testFacts: { full: Record<string, number> };
  fileCommitment: { files: Array<{ path: string; sha256: string }> };
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

function firstCommand(manifest: ReturnType<typeof readManifest>): {
  name: string;
  stdoutFile: string;
  stdoutSha256: string;
  exitCode: number;
} {
  const command = manifest.commands[0];
  assert.ok(command);
  return command;
}

function firstFile(manifest: ReturnType<typeof readManifest>): { path: string; sha256: string } {
  const entry = manifest.fileCommitment.files[0];
  assert.ok(entry);
  return entry;
}

describe("Phase 2D Corrective 4 evidence verifier", { concurrency: 1 }, () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "p2d-c4-evidence-"));
  const intactDir = path.join(tempRoot, "intact");
  const copies: string[] = [];

  before(() => {
    writeFixture(intactDir);
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

  test("E4-01 intact synthetic fixture verifies without a gate verdict", () => {
    const directory = tamper();
    const result = verify(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gateStatus=NOT_EMITTED/);
    assert.equal(result.stdout.includes("ACCEPT"), false);
    assert.equal(/PASS/.test(result.stdout), false);
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
    writeManifest(directory, manifest);
    const result = verify(directory, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_SHA: mergeSha,
      GITHUB_EVENT_PATH: eventPath,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source HEAD|merge/i);
  });

  test("E4-03 tampered tree SHA fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const otherTree = git(["rev-parse", "HEAD^{tree}"]);
    const parentTree = git(["rev-parse", "HEAD~1^{tree}"]);
    manifest.identity.sourceHeadTreeSha = parentTree === otherTree ? "0".repeat(40) : parentTree;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tree SHA/i);
  });

  test("E4-04 tampered base SHA fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.identity.baseSha = git(["rev-parse", "HEAD"]);
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /base SHA/i);
  });

  test("E4-05 tampered command exit code fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    firstCommand(manifest).exitCode = 1;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exitCode/i);
  });

  test("E4-06 tampered raw log content fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    const command = firstCommand(manifest);
    const stdoutPath = path.join(directory, command.stdoutFile);
    writeFileSync(stdoutPath, `${readFileSync(stdoutPath, "utf8")}tampered\n`);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /log hash/i);
  });

  test("E4-07 tampered raw log hash fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    firstCommand(manifest).stdoutSha256 = "0".repeat(64);
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /log hash/i);
  });

  test("E4-08 tampered full test total fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFacts.full.total = 999;
    manifest.testFacts.full.pass = 999;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /full facts|TAP/i);
  });

  test("E4-09 tampered fail/skip/todo counts fail closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.testFacts.full.fail = 1;
    manifest.testFacts.full.skip = 1;
    manifest.testFacts.full.todo = 1;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /full facts|TAP|fail=skip/i);
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
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /file hash/i);
  });

  test("E4-11 missing required field fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    delete manifest.identity.generatedAt;
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCHEMA|generatedAt|missing keys/i);
  });

  test("E4-12 extra unauthorized field fails closed", () => {
    const directory = tamper();
    const manifest = readManifest(directory);
    manifest.extra = "unauthorized";
    writeManifest(directory, manifest);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SCHEMA|unauthorized/i);
  });

  test("E4-13 absolute path in artifact fails closed", () => {
    const directory = tamper();
    const planted = path.join(path.sep, "Users", "apple", "multi-venue-grid-engine-starter");
    rewriteStdout(directory, "lint", `lint ${planted}\n`);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /absolute/i);
  });

  test("E4-14 secret-like value in artifact fails closed", () => {
    const directory = tamper();
    const planted = `ghp_${"a".repeat(36)}`;
    rewriteStdout(directory, "lint", `lint ${planted}\n`);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /secret-like/i);
  });

  test("E4-15 missing audit JSON fails closed", () => {
    const directory = tamper();
    rmSync(path.join(directory, "audit.json"));
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audit\.json is missing/i);
  });

  test("E4-16 unparseable audit JSON fails closed", () => {
    const directory = tamper();
    rewriteStdout(directory, "audit", "not-json\n");
    writeFileSync(path.join(directory, "audit.json"), "not-json\n");
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /audit JSON could not be parsed/i);
  });

  test("E4-17 audit JSON with critical vulnerability fails closed", () => {
    const directory = tamper();
    const audit = `${JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 1,
          total: 1,
        },
      },
    })}\n`;
    rewriteStdout(directory, "audit", audit);
    writeFileSync(path.join(directory, "audit.json"), audit);
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /critical/i);
  });

  test("E4-18 generator self-declared ACCEPT/PASS gate verdict fails closed", () => {
    const directory = tamper();
    rewriteStdout(
      directory,
      "lint",
      '{"requestedVerdict":"ACCEPT","PHASE_2D_CORRECTIVE_4":"PASS"}\n',
    );
    const result = verify(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /gate verdict/i);
  });
});
