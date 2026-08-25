/**
 * GitHub API helpers for the trusted freeze checker.
 * Fail closed on truncation, missing fields, or unfollowed pagination.
 */

import { GIT_SHA1_RE } from "./phase2d-trusted-freeze-lib.mjs";

export function parseLinkRelNext(linkHeader) {
  if (typeof linkHeader !== "string" || linkHeader.length === 0) {
    return null;
  }
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export function paginationStatus({
  truncated,
  incompleteResults,
  itemCount,
  perPage,
  linkHeader,
  followNext,
}) {
  if (truncated === true) {
    return { complete: false, reason: "github_tree_truncated" };
  }
  if (incompleteResults === true) {
    return { complete: false, reason: "github_incomplete_results" };
  }
  const next = parseLinkRelNext(linkHeader);
  if (next && followNext !== true) {
    return { complete: false, reason: "github_pagination_unfollowed" };
  }
  if (typeof perPage === "number" && itemCount > perPage) {
    return { complete: false, reason: "github_pagination_overflow" };
  }
  if (typeof perPage === "number" && itemCount === perPage && next && followNext !== true) {
    return { complete: false, reason: "github_pagination_unfollowed" };
  }
  return { complete: true, next };
}

export async function githubGetJson(url, { token, fetchImpl, headers } = {}) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    return { ok: false, reason: "github_url_invalid", status: 0, json: null, link: null };
  }
  const fetchFn = fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    return { ok: false, reason: "github_fetch_unavailable", status: 0, json: null, link: null };
  }
  const response = await fetchFn(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  });
  const link = response.headers?.get?.("link") ?? response.headers?.get?.("Link") ?? null;
  let json = null;
  try {
    json = await response.json();
  } catch {
    return { ok: false, reason: "github_json_invalid", status: response.status, json: null, link };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: "github_http_error",
      status: response.status,
      json,
      link,
    };
  }
  return { ok: true, reason: null, status: response.status, json, link };
}

export async function collectPaginatedItems({
  firstUrl,
  token,
  fetchImpl,
  followNext = true,
  perPage = 100,
  maxPages = 50,
  itemsFrom,
}) {
  const items = [];
  let url = firstUrl;
  let pages = 0;
  while (url) {
    pages += 1;
    if (pages > maxPages) {
      return { complete: false, reason: "github_pagination_max_pages", items };
    }
    const page = await githubGetJson(url, { token, fetchImpl });
    if (!page.ok) {
      return { complete: false, reason: page.reason, items, status: page.status };
    }
    const pageItems = itemsFrom(page.json);
    if (!Array.isArray(pageItems)) {
      return { complete: false, reason: "github_page_items_missing", items };
    }
    const status = paginationStatus({
      truncated: page.json?.truncated,
      incompleteResults: page.json?.incomplete_results,
      itemCount: pageItems.length,
      perPage,
      linkHeader: page.link,
      followNext,
    });
    items.push(...pageItems);
    if (!status.complete && status.reason !== undefined && status.next && followNext !== true) {
      return { complete: false, reason: status.reason, items };
    }
    if (page.json?.truncated === true || page.json?.incomplete_results === true) {
      return { complete: false, reason: status.reason, items };
    }
    if (status.next && followNext === true) {
      url = status.next;
      continue;
    }
    if (status.next && followNext !== true) {
      return { complete: false, reason: "github_pagination_unfollowed", items };
    }
    if (!status.complete) {
      return { complete: false, reason: status.reason, items };
    }
    url = null;
  }
  return { complete: true, reason: null, items };
}

export function repoApiRoot(apiUrl, repository) {
  if (typeof apiUrl !== "string" || !apiUrl.startsWith("https://")) {
    return null;
  }
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    return null;
  }
  return `${apiUrl.replace(/\/$/, "")}/repos/${repository}`;
}

export async function fetchCommitTreeSha({ apiUrl, repository, commitSha, token, fetchImpl }) {
  if (!GIT_SHA1_RE.test(commitSha ?? "")) {
    return { complete: false, reason: "commit_sha_invalid", treeSha: null };
  }
  const root = repoApiRoot(apiUrl, repository);
  if (!root) {
    return { complete: false, reason: "repository_identity_mismatch", treeSha: null };
  }
  const page = await githubGetJson(`${root}/commits/${commitSha}`, { token, fetchImpl });
  if (!page.ok) {
    return { complete: false, reason: page.reason, treeSha: null, status: page.status };
  }
  const sha = page.json?.sha;
  const treeSha = page.json?.commit?.tree?.sha;
  if (sha !== commitSha) {
    return { complete: false, reason: "commit_sha_response_mismatch", treeSha: null };
  }
  if (!GIT_SHA1_RE.test(treeSha ?? "")) {
    return { complete: false, reason: "commit_tree_sha_missing", treeSha: null };
  }
  return { complete: true, reason: null, treeSha, parents: page.json?.parents ?? [] };
}

export async function fetchRecursiveTree({ apiUrl, repository, treeSha, token, fetchImpl }) {
  if (!GIT_SHA1_RE.test(treeSha ?? "")) {
    return { complete: false, reason: "tree_sha_invalid", entries: [] };
  }
  const root = repoApiRoot(apiUrl, repository);
  if (!root) {
    return { complete: false, reason: "repository_identity_mismatch", entries: [] };
  }
  const page = await githubGetJson(`${root}/git/trees/${treeSha}?recursive=1`, {
    token,
    fetchImpl,
  });
  if (!page.ok) {
    return { complete: false, reason: page.reason, entries: [], status: page.status };
  }
  if (page.json?.truncated === true) {
    return { complete: false, reason: "github_tree_truncated", entries: [] };
  }
  if (!Array.isArray(page.json?.tree)) {
    return { complete: false, reason: "github_tree_missing", entries: [] };
  }
  const entries = [];
  for (const item of page.json.tree) {
    if (!item || typeof item.path !== "string") {
      return { complete: false, reason: "github_tree_entry_invalid", entries: [] };
    }
    entries.push({
      path: item.path,
      mode: item.mode,
      type: item.type,
      sha: item.sha,
    });
  }
  return { complete: true, reason: null, entries, treeSha: page.json.sha ?? treeSha };
}

export async function fetchCompareAncestor({
  apiUrl,
  repository,
  baseSha,
  headSha,
  token,
  fetchImpl,
}) {
  if (!GIT_SHA1_RE.test(baseSha ?? "") || !GIT_SHA1_RE.test(headSha ?? "")) {
    return { complete: false, reason: "compare_sha_invalid", isAncestor: false };
  }
  const root = repoApiRoot(apiUrl, repository);
  if (!root) {
    return { complete: false, reason: "repository_identity_mismatch", isAncestor: false };
  }
  const page = await githubGetJson(`${root}/compare/${baseSha}...${headSha}`, {
    token,
    fetchImpl,
  });
  if (!page.ok) {
    return { complete: false, reason: page.reason, isAncestor: false, status: page.status };
  }
  if (typeof page.json?.behind_by !== "number" || typeof page.json?.ahead_by !== "number") {
    return { complete: false, reason: "compare_fields_missing", isAncestor: false };
  }
  if (Array.isArray(page.json.files) && page.json.files.length >= 300) {
    return {
      complete: false,
      reason: "compare_files_unpaginated_limit",
      isAncestor: page.json.behind_by === 0,
      files: page.json.files,
    };
  }
  return {
    complete: true,
    reason: null,
    isAncestor: page.json.behind_by === 0,
    aheadBy: page.json.ahead_by,
    behindBy: page.json.behind_by,
    status: page.json.status,
    files: Array.isArray(page.json.files) ? page.json.files : [],
  };
}

export async function fetchBlobUtf8({ apiUrl, repository, blobSha, token, fetchImpl }) {
  if (!GIT_SHA1_RE.test(blobSha ?? "")) {
    return { complete: false, reason: "blob_sha_invalid", text: null };
  }
  const root = repoApiRoot(apiUrl, repository);
  if (!root) {
    return { complete: false, reason: "repository_identity_mismatch", text: null };
  }
  const page = await githubGetJson(`${root}/git/blobs/${blobSha}`, { token, fetchImpl });
  if (!page.ok) {
    return { complete: false, reason: page.reason, text: null, status: page.status };
  }
  if (page.json?.encoding !== "base64" || typeof page.json?.content !== "string") {
    return { complete: false, reason: "blob_encoding_unsupported", text: null };
  }
  try {
    const text = Buffer.from(page.json.content.replace(/\s+/g, ""), "base64").toString("utf8");
    return { complete: true, reason: null, text };
  } catch {
    return { complete: false, reason: "blob_decode_failed", text: null };
  }
}
