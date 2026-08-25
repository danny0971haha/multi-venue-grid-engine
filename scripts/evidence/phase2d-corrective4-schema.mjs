/**
 * Schema v2 constants for Phase 2D Corrective 4 evidence closure.
 * Historical schema v1 (`multi-venue-phase2d-corrective4/1`) is not redefined here.
 * This module must not contain parsers, evaluators, generators, verifiers,
 * filesystem scans, git commands, or safety decisions.
 */

export const SCHEMA_ID = "multi-venue-phase2d-corrective4/2";
export const VERIFIER_SCHEMA_ID = "multi-venue-phase2d-corrective4-verifier/2";
export const ARTIFACT_DIR_REL = "artifacts/phase2d-corrective4";
export const REPOSITORY = "danny0971haha/multi-venue-grid-engine";
export const SOURCE_BRANCH = "experiment/v0.1-phase2";
export const IMPLEMENTATION_BASE_SHA = "c64fa291af0d53139c6c526cd25ede434c08c17b";
export const EXPECTED_BASE_SHA = "057732cee021889d17573425ee4f24e2065df1e9";
export const PINNED_NODE = "v22.23.2";
export const PINNED_NPM = "10.9.8";
export const PRIOR_CUMULATIVE_TEST_TOTAL = 428;
export const CORRECTIVE4_FOCUSED_TOTAL = 15;
export const EVIDENCE_VERIFIER_TOTAL = 46;
export const EXPECTED_FULL_TOTAL = PRIOR_CUMULATIVE_TEST_TOTAL + EVIDENCE_VERIFIER_TOTAL;
export const EVIDENCE_TEST_REL = "test/evidence/phase2d-corrective4-evidence.test.ts";
export const CORRECTIVE4_TEST_REL = "test/risk/risk-engine-corrective-4.test.ts";

export const EXPECTED_NPM_TEST_SCRIPT =
  "tsx --test --test-reporter tap test/bootstrap/*.test.ts test/math/*.test.ts test/domain/*.test.ts test/strategy/*.test.ts test/simulator/*.test.ts test/persistence/*.test.ts test/risk/*.test.ts test/evidence/*.test.ts";

export const EXPECTED_NPM_CORRECTIVE4_SCRIPT =
  "tsx --test --test-reporter tap test/risk/risk-engine-corrective-4.test.ts";

export const EXPECTED_NPM_EVIDENCE_SCRIPT =
  "node --import tsx --test --test-reporter=tap test/evidence/phase2d-corrective4-evidence.test.ts";

export const EXPECTED_DRY_RUN_SCRIPT = "tsx src/index.ts";

export const SHA1_HEX_PATTERN = "^[0-9a-f]{40}$";
export const CANONICAL_UINT_PATTERN = "^(0|[1-9][0-9]*)$";
export const ISO_UTC_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

export const REQUIRED_FULL_TEST_GLOBS = Object.freeze([
  "test/bootstrap/*.test.ts",
  "test/math/*.test.ts",
  "test/domain/*.test.ts",
  "test/strategy/*.test.ts",
  "test/simulator/*.test.ts",
  "test/persistence/*.test.ts",
  "test/risk/*.test.ts",
  "test/evidence/*.test.ts",
]);

export const TEST_SUITE_BY_DIR = Object.freeze({
  "test/bootstrap": "bootstrap",
  "test/math": "math",
  "test/domain": "domain",
  "test/strategy": "strategy",
  "test/simulator": "simulator",
  "test/persistence": "persistence",
  "test/risk": "risk",
});

export const ALLOWED_TEST_SUITES = Object.freeze([
  "bootstrap",
  "math",
  "domain",
  "strategy",
  "simulator",
  "persistence",
  "risk",
  "evidenceVerifier",
]);

export const REQUIRED_COMMANDS = Object.freeze([
  Object.freeze({ name: "format:check", argv: Object.freeze(["npm", "run", "format:check"]) }),
  Object.freeze({ name: "lint", argv: Object.freeze(["npm", "run", "lint"]) }),
  Object.freeze({ name: "typecheck", argv: Object.freeze(["npm", "run", "typecheck"]) }),
  Object.freeze({
    name: "test:phase2d-corrective-4",
    argv: Object.freeze(["npm", "run", "test:phase2d-corrective-4"]),
  }),
  Object.freeze({
    name: "test:evidence:phase2d-corrective4",
    argv: Object.freeze(["npm", "run", "test:evidence:phase2d-corrective4"]),
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

export const VERIFIER_OWNED_CORRECTIVE4_ARGV = Object.freeze([
  "node",
  "--import",
  "tsx",
  "--test",
  "--test-reporter=tap",
  CORRECTIVE4_TEST_REL,
]);

export const VERIFIER_OWNED_EVIDENCE_ARGV = Object.freeze([
  "node",
  "--import",
  "tsx",
  "--test",
  "--test-reporter=tap",
  EVIDENCE_TEST_REL,
]);

export const MANIFEST_KEYS = Object.freeze([
  "schema",
  "identity",
  "toolchain",
  "commands",
  "testFacts",
  "auditFacts",
  "safety",
  "fileCommitment",
  "testFileInventory",
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

export const TEST_FACTS_KEYS = Object.freeze([
  "priorCumulativeTestTotal",
  "corrective4",
  "evidenceVerifier",
  "full",
]);

export const AUDIT_COUNT_KEYS = Object.freeze([
  "info",
  "low",
  "moderate",
  "high",
  "critical",
  "total",
]);

export const AUDIT_FACTS_KEYS = Object.freeze([
  "auditReportVersion",
  "metadataCounts",
  "observedRowCounts",
  "metadataMatchesRows",
  "vulnerabilityKeys",
  "auditZero",
]);

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
export const TEST_FILE_INVENTORY_KEYS = Object.freeze(["files"]);
export const TEST_FILE_ENTRY_KEYS = Object.freeze(["path", "sha256", "suite"]);

export const FORBIDDEN_MANIFEST_KEYS = Object.freeze([
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

export const COMMITMENT_EXACT = Object.freeze([
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

export const COMMITMENT_PREFIXES = Object.freeze([
  "src/risk/",
  "test/risk/",
  "scripts/evidence/",
  "test/evidence/",
]);

export class EvidenceError extends Error {
  /**
   * @param {string} code
   * @param {string} detail
   */
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "EvidenceError";
    this.code = code;
    this.detail = detail;
  }
}
