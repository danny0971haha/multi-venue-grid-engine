import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RUNTIME_MODE,
  EXPERIMENT_SPEC_VERSION,
  LIVE_MODE_NOT_IMPLEMENTED,
  bootDryRun,
  resolveRuntimeMode,
} from "../../src/bootstrap/runtimeMode.js";

const repositoryRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tsxCli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runBootstrap(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [absolutePath] : [];
  });
}

test("missing RUNTIME_MODE resolves to DRY_RUN", () => {
  assert.equal(resolveRuntimeMode(undefined), DEFAULT_RUNTIME_MODE);
  assert.equal(resolveRuntimeMode(""), DEFAULT_RUNTIME_MODE);
  assert.equal(DEFAULT_RUNTIME_MODE, "DRY_RUN");
});

test("explicit DRY_RUN resolves successfully", () => {
  assert.equal(resolveRuntimeMode("DRY_RUN"), "DRY_RUN");
  assert.deepEqual(bootDryRun("DRY_RUN"), {
    project: "multi-venue-grid-engine",
    runtimeMode: "DRY_RUN",
    liveExchangeWrites: false,
    phase: 0,
    experimentSpecVersion: EXPERIMENT_SPEC_VERSION,
  });
});

test("unknown runtime mode is rejected", () => {
  assert.throws(() => resolveRuntimeMode("paper"), /UNSUPPORTED_RUNTIME_MODE:paper/);
  assert.throws(() => resolveRuntimeMode("dry-run"), /UNSUPPORTED_RUNTIME_MODE:dry-run/);
});

test("LIVE startup is rejected with LIVE_MODE_NOT_IMPLEMENTED", () => {
  assert.throws(() => bootDryRun("LIVE"), /LIVE_MODE_NOT_IMPLEMENTED/);

  const result = runBootstrap({ RUNTIME_MODE: "LIVE" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(LIVE_MODE_NOT_IMPLEMENTED));
  assert.equal(result.stdout.includes("liveExchangeWrites"), false);
});

test("dry-run bootstrap performs zero network or exchange mutations", () => {
  const report = bootDryRun();
  assert.equal(report.liveExchangeWrites, false);

  const sourceRoot = path.join(repositoryRoot, "src");
  const networkImport =
    /from ["'](?:node:(?:http|https|net|dns|tls|dgram|undici)|https?|net|undici|ws|axios|websocket)["']/;

  for (const filePath of listTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    assert.equal(networkImport.test(source), false, filePath);
    assert.equal(source.includes("placeOrder"), false, filePath);
    assert.equal(source.includes("cancelOrder"), false, filePath);
  }
});

test("bootstrap exposes frozen experiment metadata 0.1.0", () => {
  const report = bootDryRun();
  assert.equal(report.experimentSpecVersion, "0.1.0");
  assert.equal("startingCapitalUsdt" in report, false);
  assert.equal("leverage" in report, false);
});

test("environment parsing does not echo secrets", () => {
  const secret = "phase0-local-fixture-not-a-credential";
  const result = runBootstrap({
    RUNTIME_MODE: "DRY_RUN",
    EXCHANGE_API_KEY: secret,
    API_SECRET: secret,
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stderr.includes(secret), false);
});
