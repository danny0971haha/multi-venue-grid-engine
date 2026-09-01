import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { classifyGate, classifyPullRequestEvent, runTrustedGate } from "./phase2d-trusted-gate.mjs";
import { parseBaseline, TRUSTED_BASELINE_PATH } from "./phase2d-trusted-freeze-lib.mjs";
import {
  PHASE2E_CANDIDATE_HEAD_SHA,
  PHASE2E_FROZEN_BASE_SHA,
  PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA,
  PHASE2E_STALE_CORRECTIVE2_HEAD_SHA,
  PHASE2E_TRUSTED_BASELINE_PATH,
  parsePhase2eBaseline,
} from "./phase2e-trusted-freeze-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "danny0971haha/multi-venue-grid-engine";
const phase2e = parsePhase2eBaseline(
  readFileSync(path.join(root, PHASE2E_TRUSTED_BASELINE_PATH), "utf8"),
).baseline;
const fixtures = path.join(root, "scripts", "governance", "fixtures", "events");

function phase2dLite() {
  return {
    repository: REPO,
    candidateHeadRef: "experiment/v0.1-phase2",
    protectedPathRules: ["src/**", "test/risk/**", "package-lock.json"],
    allowedEvidenceOnlyChangedPathRules: ["scripts/evidence/**", "docs/PHASE_2D_CONTRACT.md"],
    trustedGovernancePathRules: phase2e.trustedGovernancePathRules,
  };
}

function exactPhase2e(overrides = {}) {
  return {
    baseline: phase2dLite(),
    phase2eBaseline: phase2e,
    changedPaths: [...phase2e.allowedChangedPaths],
    headRef: phase2e.candidateHeadRef,
    headSha: phase2e.candidateHeadSha,
    headRepository: REPO,
    baseRepository: REPO,
    baseRef: phase2e.candidateBaseRef,
    baseSha: phase2e.frozenBaseSha,
    prNumber: 7,
    ...overrides,
  };
}

function eventFixture(name) {
  return JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));
}

function jsonResponse(body, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get(headerName) {
        return headerName.toLowerCase() === "link" ? link : null;
      },
    },
  };
}

describe("Phase 2E and Phase 2D gate routing", () => {
  it("accepts the exact Phase 2D candidate branch", () => {
    assert.equal(
      classifyGate({
        baseline: phase2dLite(),
        phase2eBaseline: phase2e,
        changedPaths: ["docs/PHASE_2D_CONTRACT.md"],
        headRef: "experiment/v0.1-phase2",
        headSha: PHASE2E_FROZEN_BASE_SHA,
        headRepository: REPO,
        baseRepository: REPO,
        baseRef: "main",
        baseSha: "a".repeat(40),
      }).mode,
      "PHASE2D_ENFORCE",
    );
  });

  it("accepts the exact Phase 2E stacked candidate", () => {
    const result = classifyGate(exactPhase2e());
    assert.equal(result.mode, "PHASE2E_ENFORCE");
    assert.equal(result.reason, "phase2e_exact_candidate");
  });

  it("fail closed on the wrong Phase 2E base branch", () => {
    assert.equal(classifyGate(exactPhase2e({ baseRef: "main" })).mode, "FAIL_CLOSED");
  });

  it("fail closed on the wrong Phase 2E base SHA", () => {
    assert.equal(classifyGate(exactPhase2e({ baseSha: "c".repeat(40) })).mode, "FAIL_CLOSED");
  });

  it("fail closed on the wrong Phase 2E head branch", () => {
    assert.equal(
      classifyGate(exactPhase2e({ headRef: "experiment/v0.1-phase2e-other" })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a stale Phase 2E head SHA", () => {
    assert.equal(
      classifyGate(exactPhase2e({ headSha: "7b98c888543b980dee48b27f4497db1bf93a7970" })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on the invalidated Runtime Corrective 1 HEAD", () => {
    assert.equal(
      classifyGate(exactPhase2e({ headSha: PHASE2E_INVALIDATED_CORRECTIVE1_HEAD_SHA })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on the stale Runtime Corrective 2 HEAD", () => {
    assert.equal(
      classifyGate(exactPhase2e({ headSha: PHASE2E_STALE_CORRECTIVE2_HEAD_SHA })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a different pull request number with the same SHA", () => {
    assert.equal(classifyGate(exactPhase2e({ prNumber: 8 })).mode, "FAIL_CLOSED");
    assert.equal(classifyGate(exactPhase2e({ prNumber: 8 })).reason, "phase2e_pr_number_mismatch");
    assert.equal(classifyGate(exactPhase2e({ prNumber: 7 })).mode, "PHASE2E_ENFORCE");
  });

  it("fail closed when a required halt test file is omitted from the PR files list", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({
          changedPaths: phase2e.allowedChangedPaths.filter(
            (filePath) => filePath !== "test/halt/p2e-corrective-3.test.ts",
          ),
        }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a forked candidate", () => {
    assert.equal(
      classifyGate(exactPhase2e({ headRepository: "attacker/multi-venue-grid-engine" })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on the same branch name from another repository", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({
          headRepository: "other-org/multi-venue-grid-engine",
          baseRepository: "other-org/multi-venue-grid-engine",
        }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on an unexpected extra file", () => {
    assert.equal(
      classifyGate(exactPhase2e({ changedPaths: [...phase2e.allowedChangedPaths, "src/index.ts"] }))
        .mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a .github workflow modification", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({
          changedPaths: [
            ...phase2e.allowedChangedPaths,
            ".github/workflows/trusted-phase2d-freeze.yml",
          ],
        }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a governance script modification", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({
          changedPaths: [
            ...phase2e.allowedChangedPaths,
            "scripts/governance/phase2d-trusted-gate.mjs",
          ],
        }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a package-lock modification", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({ changedPaths: [...phase2e.allowedChangedPaths, "package-lock.json"] }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a protected Phase 2D source modification mixed into Phase 2E", () => {
    assert.equal(
      classifyGate(
        exactPhase2e({ changedPaths: [...phase2e.allowedChangedPaths, "src/risk/risk-engine.ts"] }),
      ).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on a deleted protected file advertised in the PR files list", () => {
    assert.equal(
      classifyGate(exactPhase2e({ changedPaths: ["src/risk/risk-engine.ts"] })).mode,
      "FAIL_CLOSED",
    );
  });

  it("fail closed on an unsafe path-traversal filename", () => {
    assert.equal(
      classifyGate(exactPhase2e({ changedPaths: ["../secrets.env"] })).mode,
      "FAIL_CLOSED",
    );
  });

  it("routes a trusted governance-only PR to GOVERNANCE_REVIEW_REQUIRED", () => {
    assert.equal(
      classifyGate({
        baseline: phase2dLite(),
        phase2eBaseline: phase2e,
        changedPaths: ["scripts/governance/phase2e-trusted-freeze-lib.mjs"],
        headRef: "governance/phase2e-trusted-gate",
        headSha: "d".repeat(40),
        headRepository: REPO,
        baseRepository: REPO,
        baseRef: "main",
        baseSha: "e".repeat(40),
      }).mode,
      "GOVERNANCE_REVIEW_REQUIRED",
    );
  });

  it("routes an unrelated PR to NOT_APPLICABLE", () => {
    assert.equal(
      classifyGate({
        baseline: phase2dLite(),
        phase2eBaseline: phase2e,
        changedPaths: ["README.md"],
        headRef: "docs/readme",
        headSha: "f".repeat(40),
        headRepository: REPO,
        baseRepository: REPO,
        baseRef: "main",
        baseSha: "a".repeat(40),
      }).mode,
      "NOT_APPLICABLE",
    );
  });

  it("does not let a candidate spoof file control classification", () => {
    const result = classifyGate(
      exactPhase2e({
        changedPaths: [...phase2e.allowedChangedPaths, "phase2eTrustedRuntimeOk=true"],
      }),
    );
    assert.equal(result.mode, "FAIL_CLOSED");
  });

  it("does not classify mixed package.json and trusted governance as governance-only", () => {
    const committedPhase2d = parseBaseline(
      readFileSync(path.join(root, TRUSTED_BASELINE_PATH), "utf8"),
    );
    assert.equal(committedPhase2d.ok, true);
    const result = classifyGate({
      baseline: committedPhase2d.baseline,
      phase2eBaseline: phase2e,
      changedPaths: ["package.json", "scripts/governance/phase2e-trusted-runtime.mjs"],
      headRef: "governance/phase2e-trusted-gate",
      headSha: "d".repeat(40),
      headRepository: REPO,
      baseRepository: REPO,
      baseRef: "main",
      baseSha: "e".repeat(40),
    });
    assert.equal(result.mode, "PHASE2D_ENFORCE");
    assert.equal(result.reason, "phase2_and_trusted_paths_touched");
  });

  it("classifies a governance-only PR without package.json as review-required, not accepted", () => {
    const result = classifyGate({
      baseline: phase2dLite(),
      phase2eBaseline: phase2e,
      changedPaths: [
        ".github/workflows/trusted-phase2d-freeze.yml",
        ".github/trusted/phase2e-corrective3-baseline.json",
        "scripts/governance/phase2e-trusted-runtime.mjs",
      ],
      headRef: "governance/phase2e-trusted-gate",
      headSha: "d".repeat(40),
      headRepository: REPO,
      baseRepository: REPO,
      baseRef: "main",
      baseSha: "e".repeat(40),
    });
    assert.equal(result.mode, "GOVERNANCE_REVIEW_REQUIRED");
    assert.notEqual(result.mode, "PHASE2E_ENFORCE");
  });

  it("returns only the closed classification set", () => {
    const modes = new Set([
      "PHASE2D_ENFORCE",
      "PHASE2E_ENFORCE",
      "GOVERNANCE_REVIEW_REQUIRED",
      "NOT_APPLICABLE",
      "FAIL_CLOSED",
    ]);
    const samples = [
      classifyGate(exactPhase2e()),
      classifyGate(
        exactPhase2e({ changedPaths: ["scripts/governance/phase2e-trusted-runtime.mjs"] }),
      ),
      classifyGate({
        baseline: phase2dLite(),
        phase2eBaseline: phase2e,
        changedPaths: ["README.md"],
        headRef: "docs/readme",
        headSha: "f".repeat(40),
        headRepository: REPO,
        baseRepository: REPO,
        baseRef: "main",
        baseSha: "a".repeat(40),
      }),
      classifyPullRequestEvent({}, ["README.md"], {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }),
    ];
    for (const sample of samples) {
      assert.equal(modes.has(sample.mode), true, sample.mode);
    }
  });
});

describe("adversarial fixture events", () => {
  it("classifies committed fixture events", () => {
    assert.equal(
      classifyPullRequestEvent(eventFixture("valid-phase2e.json"), phase2e.allowedChangedPaths, {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "PHASE2E_ENFORCE",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("valid-phase2d.json"), ["docs/PHASE_2D_CONTRACT.md"], {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "PHASE2D_ENFORCE",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("fork-phase2e.json"), phase2e.allowedChangedPaths, {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("governance-only.json"), ["scripts/governance/x.mjs"], {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "GOVERNANCE_REVIEW_REQUIRED",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("unrelated.json"), ["README.md"], {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "NOT_APPLICABLE",
    );
    assert.equal(
      classifyPullRequestEvent({}, ["README.md"], {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(
        eventFixture("old-corrective1-head.json"),
        phase2e.allowedChangedPaths,
        {
          phase2dBaseline: phase2dLite(),
          phase2eBaseline: phase2e,
        },
      ).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("wrong-head.json"), phase2e.allowedChangedPaths, {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(
        eventFixture("extra-changed-path.json"),
        [...phase2e.allowedChangedPaths, "src/index.ts"],
        {
          phase2dBaseline: phase2dLite(),
          phase2eBaseline: phase2e,
        },
      ).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(
        eventFixture("omitted-test-file.json"),
        phase2e.allowedChangedPaths.filter(
          (filePath) => filePath !== "test/halt/p2e-corrective-3.test.ts",
        ),
        {
          phase2dBaseline: phase2dLite(),
          phase2eBaseline: phase2e,
        },
      ).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(
        eventFixture("malformed-pr-metadata.json"),
        phase2e.allowedChangedPaths,
        {
          phase2dBaseline: phase2dLite(),
          phase2eBaseline: phase2e,
        },
      ).mode,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPullRequestEvent(eventFixture("wrong-pr-number.json"), phase2e.allowedChangedPaths, {
        phase2dBaseline: phase2dLite(),
        phase2eBaseline: phase2e,
      }).mode,
      "FAIL_CLOSED",
    );
  });
});

describe("trusted gate CLI fail-closed API behavior", () => {
  const committedPhase2d = parseBaseline(
    readFileSync(path.join(root, TRUSTED_BASELINE_PATH), "utf8"),
  );
  assert.equal(committedPhase2d.ok, true);

  function env(overrides = {}) {
    return {
      TRUSTED_GATE_TEST_NO_EXIT: "1",
      GITHUB_TOKEN: "none",
      GITHUB_API_URL: "https://api.github.com",
      PR_NUMBER: "7",
      PR_HEAD_REF: phase2e.candidateHeadRef,
      PR_HEAD_SHA: PHASE2E_CANDIDATE_HEAD_SHA,
      PR_HEAD_REPO: REPO,
      PR_BASE_REPO: REPO,
      PR_BASE_REF: phase2e.candidateBaseRef,
      PR_BASE_SHA: PHASE2E_FROZEN_BASE_SHA,
      ...overrides,
    };
  }

  it("fail closed when PR_NUMBER is not the bound runtime PR", async () => {
    const result = await runTrustedGate({
      env: env({ PR_NUMBER: "8" }),
      repoRoot: root,
      fetchImpl: async () =>
        jsonResponse(phase2e.allowedChangedPaths.map((filename) => ({ filename }))),
    });
    assert.equal(result.mode, "FAIL_CLOSED");
    assert.equal(result.reason, "phase2e_pr_number_mismatch");
  });

  it("fail closed when the token is missing", async () => {
    const result = await runTrustedGate({ env: env({ GITHUB_TOKEN: "" }), repoRoot: root });
    assert.equal(result.mode, "FAIL_CLOSED");
    assert.equal(result.reason, "gate_metadata_unavailable");
  });

  it("fail closed on malformed API JSON", async () => {
    const result = await runTrustedGate({
      env: env(),
      repoRoot: root,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("nope");
        },
        headers: { get: () => null },
      }),
    });
    assert.equal(result.mode, "FAIL_CLOSED");
  });

  it("fail closed on API rate limit", async () => {
    const result = await runTrustedGate({
      env: env(),
      repoRoot: root,
      fetchImpl: async () => jsonResponse({ message: "API rate limit exceeded" }, { status: 429 }),
    });
    assert.equal(result.mode, "FAIL_CLOSED");
    assert.equal(result.reason, "github_http_error");
  });

  it("fail closed when pagination is incomplete", async () => {
    const link = `<https://api.github.com/repos/${REPO}/pulls/7/files?page=2>; rel="next"`;
    const result = await runTrustedGate({
      env: env(),
      repoRoot: root,
      fetchImpl: async (url) => {
        if (String(url).includes("page=2")) {
          return jsonResponse({ message: "API rate limit exceeded" }, { status: 429 });
        }
        return jsonResponse(
          Array.from({ length: 100 }, (_, index) => ({ filename: `extra/${index}.ts` })),
          { link },
        );
      },
    });
    assert.equal(result.mode, "FAIL_CLOSED");
  });

  it("fail closed when more than 100 files include an extra unexpected path after pagination", async () => {
    const link = `<https://api.github.com/repos/${REPO}/pulls/7/files?page=2>; rel="next"`;
    const first = phase2e.allowedChangedPaths
      .concat(Array.from({ length: 86 }, (_, index) => `extra/${index}.ts`))
      .slice(0, 100)
      .map((filename) => ({ filename }));
    const result = await runTrustedGate({
      env: env(),
      repoRoot: root,
      fetchImpl: async (url) => {
        if (String(url).includes("page=2")) {
          return jsonResponse([{ filename: "extra/overflow.ts" }]);
        }
        return jsonResponse(first, { link });
      },
    });
    assert.equal(result.mode, "FAIL_CLOSED");
    assert.equal(result.reason, "phase2e_changed_paths_mismatch");
  });

  it("overwrites a spoofed GITHUB_OUTPUT mode instead of trusting it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-output-"));
    const outputPath = path.join(dir, "github-output");
    writeFileSync(outputPath, "mode=PHASE2E_ENFORCE\nreason=spoofed\n");
    const result = await runTrustedGate({
      env: env({
        GITHUB_OUTPUT: outputPath,
        PR_HEAD_REF: "docs/readme",
        PR_HEAD_SHA: "a".repeat(40),
        PR_BASE_REF: "main",
        PR_BASE_SHA: "b".repeat(40),
      }),
      repoRoot: root,
      fetchImpl: async () => jsonResponse([{ filename: "README.md" }]),
    });
    assert.equal(result.mode, "NOT_APPLICABLE");
    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /mode=NOT_APPLICABLE/);
    assert.match(written, /governanceCandidateAccepted=false/);
    assert.match(written, /phase2eRuntimeAccepted=false/);
  });

  it("records a governance-only PR as review-required and not accepted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gate-gov-"));
    const outputPath = path.join(dir, "github-output");
    const result = await runTrustedGate({
      env: env({
        GITHUB_OUTPUT: outputPath,
        PR_HEAD_REF: "governance/phase2e-trusted-gate",
        PR_HEAD_SHA: "a".repeat(40),
        PR_BASE_REF: "main",
        PR_BASE_SHA: "b".repeat(40),
      }),
      repoRoot: root,
      fetchImpl: async () => jsonResponse([{ filename: "scripts/governance/x.mjs" }]),
    });
    assert.equal(result.mode, "GOVERNANCE_REVIEW_REQUIRED");
    const written = readFileSync(outputPath, "utf8");
    assert.match(written, /mode=GOVERNANCE_REVIEW_REQUIRED/);
    assert.match(written, /governanceCandidateAccepted=false/);
    assert.doesNotMatch(written, /governanceCandidateAccepted=true/);
  });
});
