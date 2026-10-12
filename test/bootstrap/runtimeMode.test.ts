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

// Follows relative static imports (including type-only ones) from src/index.ts.
function listBootstrapModules(): string[] {
  const seen = new Set<string>();
  const pending = [path.join(repositoryRoot, "src", "index.ts")];
  for (let filePath = pending.pop(); filePath !== undefined; filePath = pending.pop()) {
    if (seen.has(filePath)) {
      continue;
    }
    seen.add(filePath);
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(/(?:from|import) ["'](\.{1,2}\/[^"']+)\.js["']/g)) {
      pending.push(path.resolve(path.dirname(filePath), `${match[1] ?? ""}.ts`));
    }
  }
  return [...seen];
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

  // Phase 3A introduces the venue write port (VENUE_ADAPTER_CONTRACT §3) for the fenced
  // coordinator and its test double. Only these files may name it; none may be reachable
  // from the dry-run bootstrap.
  const placeOrderFiles = new Set([
    "src/execution/coordinator.ts",
    "src/execution/ports.ts",
    "src/simulator/venue.ts",
  ]);

  for (const filePath of listTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join("/");
    assert.equal(networkImport.test(source), false, filePath);
    assert.equal(
      source.includes("placeOrder") && !placeOrderFiles.has(relativePath),
      false,
      filePath,
    );
    assert.equal(source.includes("cancelOrder"), false, filePath);
  }

  const bootstrapModules = listBootstrapModules();
  assert.ok(bootstrapModules.includes(path.join(sourceRoot, "bootstrap", "runtimeMode.ts")));
  for (const filePath of bootstrapModules) {
    assert.equal(readFileSync(filePath, "utf8").includes("placeOrder"), false, filePath);
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
