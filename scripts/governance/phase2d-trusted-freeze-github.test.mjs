import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectPaginatedItems,
  fetchCompareAncestor,
  fetchRecursiveTree,
  githubGetJson,
  paginationStatus,
  parseLinkRelNext,
} from "./phase2d-trusted-freeze-github.mjs";

const API = "https://api.github.com";
const REPO = "danny0971haha/multi-venue-grid-engine";
const SHA = "a".repeat(40);
const TREE = "b".repeat(40);

function response(body, { status = 200, link = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: {
      get(name) {
        return name.toLowerCase() === "link" ? link : null;
      },
    },
  };
}

describe("paginationStatus", () => {
  it("fail closed when a tree is truncated", () => {
    const status = paginationStatus({ truncated: true, followNext: true });
    assert.equal(status.complete, false);
    assert.equal(status.reason, "github_tree_truncated");
  });

  it("fail closed when a next page exists but is not followed", () => {
    const link = `<${API}/repos/${REPO}/pulls/3/files?page=2>; rel="next"`;
    const status = paginationStatus({
      itemCount: 100,
      perPage: 100,
      linkHeader: link,
      followNext: false,
    });
    assert.equal(status.complete, false);
    assert.equal(status.reason, "github_pagination_unfollowed");
    assert.equal(parseLinkRelNext(link), `${API}/repos/${REPO}/pulls/3/files?page=2`);
  });
});

describe("GitHub API fail-closed wrappers", () => {
  it("12. fail closed on truncated recursive trees", async () => {
    const tree = await fetchRecursiveTree({
      apiUrl: API,
      repository: REPO,
      treeSha: TREE,
      token: "none",
      fetchImpl: async () => response({ truncated: true, tree: [], sha: TREE }),
    });
    assert.equal(tree.complete, false);
    assert.equal(tree.reason, "github_tree_truncated");
  });

  it("12. fail closed when compare metadata omits behind_by", async () => {
    const compare = await fetchCompareAncestor({
      apiUrl: API,
      repository: REPO,
      baseSha: SHA,
      headSha: SHA,
      token: "none",
      fetchImpl: async () => response({ ahead_by: 3, files: [] }),
    });
    assert.equal(compare.complete, false);
    assert.equal(compare.reason, "compare_fields_missing");
  });

  it("12. fail closed when compare metadata omits files", async () => {
    const compare = await fetchCompareAncestor({
      apiUrl: API,
      repository: REPO,
      baseSha: SHA,
      headSha: SHA,
      token: "none",
      fetchImpl: async () => response({ ahead_by: 1, behind_by: 0 }),
    });
    assert.equal(compare.complete, false);
    assert.equal(compare.reason, "compare_files_missing");
  });

  it("12. fail closed on GitHub HTTP 429", async () => {
    const page = await githubGetJson(`${API}/rate_limit`, {
      token: "none",
      fetchImpl: async () =>
        response({ message: "API rate limit exceeded" }, { status: 429 }),
    });
    assert.equal(page.ok, false);
    assert.equal(page.reason, "github_http_error");
    assert.equal(page.status, 429);
  });

  it("12. fail closed when compare files hit the unpaginated 300 limit", async () => {
    const compare = await fetchCompareAncestor({
      apiUrl: API,
      repository: REPO,
      baseSha: SHA,
      headSha: SHA,
      token: "none",
      fetchImpl: async () =>
        response({
          ahead_by: 1,
          behind_by: 0,
          files: Array.from({ length: 300 }, (_, index) => ({ filename: `f${index}` })),
        }),
    });
    assert.equal(compare.complete, false);
    assert.equal(compare.reason, "compare_files_unpaginated_limit");
  });

  it("12. fail closed when pagination is not followed", async () => {
    const link = `<${API}/repos/${REPO}/pulls/3/files?page=2>; rel="next"`;
    const collected = await collectPaginatedItems({
      firstUrl: `${API}/repos/${REPO}/pulls/3/files?per_page=100`,
      token: "none",
      followNext: false,
      perPage: 100,
      itemsFrom: (json) => json.files,
      fetchImpl: async () =>
        response({ files: Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}` })) }, { link }),
    });
    assert.equal(collected.complete, false);
    assert.equal(collected.reason, "github_pagination_unfollowed");
  });
});
