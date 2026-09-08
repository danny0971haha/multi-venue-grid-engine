"""Live and offline read-only collection of GitHub protection sources."""

from __future__ import annotations

import json
import platform
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .constants import (
    DOCUMENTATION_BASIS,
    GITHUB_API_VERSION,
    GRAPHQL_PAGE_SIZE,
    IDENTITY_DISCLAIMER,
    MAX_PAGES,
    REST_PER_PAGE,
    TOOL_NAME,
    VERSION,
)
from .pagination import graphql_pagination_status, merge_unique, next_page_number, rest_pagination_status
from .redact import redact_text
from .transport import HttpExchange, Transport, utc_now

BRANCH_PROTECTION_RULES_QUERY = """
query ProtectionCollectorV2BranchProtectionRules($owner: String!, $name: String!, $cursor: String) {
  viewer { login databaseId }
  rateLimit { limit remaining used resetAt cost }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    databaseId
    isPrivate
    owner { login __typename }
    defaultBranchRef { name }
    branchProtectionRules(first: 50, after: $cursor) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        databaseId
        pattern
        isAdminEnforced
        requiresStatusChecks
        requiresStrictStatusChecks
        requiredStatusCheckContexts
        requiredStatusChecks { context app { databaseId name slug } }
        requiresApprovingReviews
        requiredApprovingReviewCount
        requiresCodeOwnerReviews
        requiresConversationResolution
        requiresCommitSignatures
        requiresLinearHistory
        requireLastPushApproval
        allowsForcePushes
        allowsDeletions
        lockBranch
        lockAllowsFetchAndMerge
        blocksCreations
        restrictsPushes
        restrictsReviewDismissals
        dismissesStaleReviews
        requiresDeployments
        requiredDeploymentEnvironments
        matchingRefs(first: 1) { totalCount pageInfo { hasNextPage } }
        bypassForcePushAllowances(first: 20) {
          pageInfo { hasNextPage }
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { slug name }
              ... on App { databaseId slug name }
            }
          }
        }
        bypassPullRequestAllowances(first: 20) {
          pageInfo { hasNextPage }
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { slug name }
              ... on App { databaseId slug name }
            }
          }
        }
        pushAllowances(first: 20) {
          pageInfo { hasNextPage }
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { slug name }
              ... on App { databaseId slug name }
            }
          }
        }
        reviewDismissalAllowances(first: 20) {
          pageInfo { hasNextPage }
          nodes {
            actor {
              __typename
              ... on User { login }
              ... on Team { slug name }
              ... on App { databaseId slug name }
            }
          }
        }
      }
    }
  }
}
"""


@dataclass
class CollectConfig:
    owner: str
    repo: str
    review_pr: int
    expected_main: str
    review_head: str
    review_tree: str
    known_ruleset_id: int
    expected_context: str
    frozen_refs: list[str]
    out_dir: Path
    per_page: int = REST_PER_PAGE
    max_pages: int = MAX_PAGES


@dataclass
class SourceResult:
    name: str
    exchanges: list[str]
    status: str
    http_statuses: list[int]
    pagination: dict[str, Any] = field(default_factory=dict)
    items: list[Any] = field(default_factory=list)
    duplicates: list[Any] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class CollectionBundle:
    config: CollectConfig
    started_at: str
    finished_at: str | None
    environment: dict[str, Any]
    actor: dict[str, Any]
    identity_before: dict[str, Any]
    identity_after: dict[str, Any]
    drift: dict[str, Any]
    sources: dict[str, SourceResult]
    target_branches: list[str]
    gaps: list[dict[str, Any]]
    documentation_basis: list[dict[str, str]]


def classify_http(exchange: HttpExchange) -> str:
    remaining = None
    for key, value in exchange.headers.items():
        if key.lower() == "x-ratelimit-remaining":
            try:
                remaining = int(value)
            except ValueError:
                remaining = None
    retry_after = None
    for key, value in exchange.headers.items():
        if key.lower() == "retry-after":
            retry_after = value
    message = ""
    if isinstance(exchange.parsed, dict):
        message = str(exchange.parsed.get("message") or "")
    if exchange.status == 401:
        return "AUTH_FAILED"
    if exchange.status in (403, 429) or remaining == 0 or retry_after:
        lowered = message.lower()
        if exchange.status == 429 or remaining == 0 or "rate limit" in lowered or retry_after:
            return "RATE_LIMITED"
        if exchange.status == 403:
            return "FORBIDDEN"
    if exchange.status == 404:
        if message == "Branch not protected":
            return "CLASSIC_NOT_PROTECTED_MESSAGE"
        return "NOT_FOUND"
    if exchange.status == 0 or exchange.status >= 500:
        return "TRANSPORT_OR_SERVER_ERROR"
    if exchange.status != 200:
        return "HTTP_ERROR"
    if not exchange.parse_ok:
        return "MALFORMED"
    if exchange.graphql and isinstance(exchange.parsed, dict) and exchange.parsed.get("errors"):
        return "GRAPHQL_ERRORS"
    return "OK"


def _as_list(parsed: Any) -> list[Any] | None:
    if isinstance(parsed, list):
        return parsed
    return None


def _repo_path(config: CollectConfig) -> str:
    return f"repos/{config.owner}/{config.repo}"


def _gh_auth_status() -> dict[str, Any]:
    env_result: dict[str, Any] = {"command": ["gh", "auth", "status"], "ran": False}
    try:
        completed = subprocess.run(
            ["gh", "auth", "status"],
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
        env_result["ran"] = True
        env_result["exit"] = completed.returncode
        combined = redact_text((completed.stdout or "") + "\n" + (completed.stderr or ""))
        env_result["text"] = combined.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        env_result["error"] = type(exc).__name__
    return env_result


def _tool_versions() -> dict[str, Any]:
    def _run(cmd: list[str]) -> str:
        try:
            completed = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=15)
            return redact_text((completed.stdout or completed.stderr or "").strip())
        except (OSError, subprocess.TimeoutExpired):
            return "UNAVAILABLE"

    return {
        "python": platform.python_version(),
        "python_implementation": platform.python_implementation(),
        "platform": f"{platform.system()} {platform.release()} {platform.machine()}",
        "gh": _run(["gh", "--version"]),
        "git": _run(["git", "--version"]),
        "github_api_version_header": GITHUB_API_VERSION,
        "collector_version": VERSION,
        "tool_name": TOOL_NAME,
        "identity_disclaimer": IDENTITY_DISCLAIMER,
    }


def capture_environment(tool_root: Path) -> dict[str, Any]:
    hashes: dict[str, str] = {}
    import hashlib

    for path in sorted(tool_root.rglob("*")):
        if not path.is_file():
            continue
        if path.name == "SHA256SUMS" or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(tool_root).as_posix()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        hashes[relative] = digest
    git_head = None
    git_tree = None
    git_dirty = None
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD", "HEAD^{tree}"],
            cwd=tool_root,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )
        lines = [line.strip() for line in (completed.stdout or "").splitlines() if line.strip()]
        if len(lines) >= 2:
            git_head, git_tree = lines[0], lines[1]
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=tool_root,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )
        git_dirty = bool((dirty.stdout or "").strip())
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {
        "captured_at": utc_now(),
        "versions": _tool_versions(),
        "gh_auth_status": _gh_auth_status(),
        "source_files_sha256": hashes,
        "git_head": git_head,
        "git_tree": git_tree,
        "git_dirty": git_dirty,
        "documentation_basis": DOCUMENTATION_BASIS,
    }


def _scope_from_headers(headers: dict[str, str]) -> dict[str, Any]:
    scopes = None
    accepted = None
    accepted_permissions = None
    for key, value in headers.items():
        lower = key.lower()
        if lower == "x-oauth-scopes":
            scopes = [item.strip() for item in value.split(",") if item.strip()]
        elif lower == "x-accepted-oauth-scopes":
            accepted = [item.strip() for item in value.split(",") if item.strip()]
        elif lower == "x-accepted-github-permissions":
            accepted_permissions = value
    return {
        "oauth_scopes": scopes,
        "accepted_oauth_scopes": accepted,
        "accepted_github_permissions": accepted_permissions,
        "token_not_recorded": True,
    }


def fetch_actor(transport: Transport) -> tuple[dict[str, Any], HttpExchange]:
    exchange = transport.rest_get("user")
    actor: dict[str, Any] = {
        "http_class": classify_http(exchange),
        "permissions": _scope_from_headers(exchange.headers),
        "login": None,
        "id": None,
        "type": None,
        "token_recorded": False,
    }
    if isinstance(exchange.parsed, dict):
        actor["login"] = exchange.parsed.get("login")
        actor["id"] = exchange.parsed.get("id")
        actor["type"] = exchange.parsed.get("type")
    return actor, exchange


def _tree_sha_from_commit(parsed: Any) -> str | None:
    if not isinstance(parsed, dict):
        return None
    commit = parsed.get("commit") if isinstance(parsed.get("commit"), dict) else None
    if commit and isinstance(commit.get("tree"), dict):
        return commit["tree"].get("sha")
    if isinstance(parsed.get("tree"), dict):
        return parsed["tree"].get("sha")
    return None


def capture_identity(transport: Transport, config: CollectConfig, label: str) -> dict[str, Any]:
    repo_ex = transport.rest_get(_repo_path(config))
    pr_ex = transport.rest_get(f"{_repo_path(config)}/pulls/{config.review_pr}")
    prs_ex = transport.rest_get(
        f"{_repo_path(config)}/pulls",
        {"state": "open", "per_page": config.per_page, "page": 1},
    )
    main_ex = transport.rest_get(f"{_repo_path(config)}/commits/{config.expected_main}")
    head_ex = transport.rest_get(f"{_repo_path(config)}/commits/{config.review_head}")
    rate_ex = transport.rest_get("rate_limit")

    repo_parsed = repo_ex.parsed if isinstance(repo_ex.parsed, dict) else {}
    pr_parsed = pr_ex.parsed if isinstance(pr_ex.parsed, dict) else {}
    prs = _as_list(prs_ex.parsed) or []
    open_prs = []
    for item in prs:
        if not isinstance(item, dict):
            continue
        head = item.get("head") or {}
        base = item.get("base") or {}
        open_prs.append(
            {
                "number": item.get("number"),
                "title": item.get("title"),
                "draft": item.get("draft"),
                "head_ref": head.get("ref"),
                "head_sha": head.get("sha"),
                "base_ref": base.get("ref"),
                "base_sha": base.get("sha"),
            }
        )
    observed_head = (pr_parsed.get("head") or {}).get("sha")
    observed_base = (pr_parsed.get("base") or {}).get("sha")
    observed_base_ref = (pr_parsed.get("base") or {}).get("ref")
    observed_head_ref = (pr_parsed.get("head") or {}).get("ref")
    observed_tree = _tree_sha_from_commit(head_ex.parsed)
    main_sha = main_ex.parsed.get("sha") if isinstance(main_ex.parsed, dict) else None
    main_tree = _tree_sha_from_commit(main_ex.parsed)
    identity = {
        "label": label,
        "captured_at": utc_now(),
        "exchange_ids": [repo_ex.id, pr_ex.id, prs_ex.id, main_ex.id, head_ex.id, rate_ex.id],
        "http_classes": {
            "repo": classify_http(repo_ex),
            "pr": classify_http(pr_ex),
            "open_prs": classify_http(prs_ex),
            "expected_main_commit": classify_http(main_ex),
            "review_head_commit": classify_http(head_ex),
            "rate_limit": classify_http(rate_ex),
        },
        "owner_login": (repo_parsed.get("owner") or {}).get("login"),
        "owner_type": (repo_parsed.get("owner") or {}).get("type"),
        "default_branch": repo_parsed.get("default_branch"),
        "visibility": repo_parsed.get("visibility") or repo_parsed.get("private"),
        "review_pr": {
            "number": pr_parsed.get("number"),
            "state": pr_parsed.get("state"),
            "draft": pr_parsed.get("draft"),
            "head_ref": observed_head_ref,
            "head_sha": observed_head,
            "head_tree": observed_tree,
            "base_ref": observed_base_ref,
            "base_sha": observed_base,
        },
        "main": {"sha": main_sha, "tree": main_tree},
        "open_prs": open_prs,
        "open_prs_pagination": {
            "page": 1,
            "count": len(prs),
            "next_page": next_page_number(repo_header(prs_ex, "link")),
            "complete": next_page_number(repo_header(prs_ex, "link")) is None and classify_http(prs_ex) == "OK",
        },
        "expected": {
            "review_head": config.review_head,
            "review_tree": config.review_tree,
            "expected_main": config.expected_main,
        },
        "match": {
            "head": observed_head == config.review_head,
            "tree": observed_tree == config.review_tree if observed_tree else None,
            "main": main_sha == config.expected_main,
        },
    }
    return identity


def repo_header(exchange: HttpExchange, name: str) -> str | None:
    lower = name.lower()
    for key, value in exchange.headers.items():
        if key.lower() == lower:
            return value
    return None


def compare_identity(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    keys = [
        ("review_pr.head_sha", (before.get("review_pr") or {}).get("head_sha"), (after.get("review_pr") or {}).get("head_sha")),
        ("review_pr.head_tree", (before.get("review_pr") or {}).get("head_tree"), (after.get("review_pr") or {}).get("head_tree")),
        ("review_pr.base_sha", (before.get("review_pr") or {}).get("base_sha"), (after.get("review_pr") or {}).get("base_sha")),
        ("main.sha", (before.get("main") or {}).get("sha"), (after.get("main") or {}).get("sha")),
        ("owner_type", before.get("owner_type"), after.get("owner_type")),
        ("default_branch", before.get("default_branch"), after.get("default_branch")),
    ]
    changed = []
    for name, left, right in keys:
        if left != right:
            changed.append({"field": name, "before": left, "after": right})
    before_prs = {(p.get("number"), p.get("base_ref"), p.get("base_sha")) for p in before.get("open_prs") or []}
    after_prs = {(p.get("number"), p.get("base_ref"), p.get("base_sha")) for p in after.get("open_prs") or []}
    if before_prs != after_prs:
        changed.append({"field": "open_prs", "before": sorted(before_prs), "after": sorted(after_prs)})
    return {
        "drift_detected": bool(changed),
        "changed": changed,
        "note": (
            "Before and after are separate observations. They are not merged into one snapshot."
            if changed
            else "No identity field listed here changed between the two captures."
        ),
    }


def paginate_rest_list(
    transport: Transport,
    path: str,
    params: dict[str, Any],
    *,
    key_fn,
    max_pages: int,
) -> SourceResult:
    exchanges: list[HttpExchange] = []
    pages: list[Any] = []
    next_page = 1
    last_status = None
    last_count = None
    link_next = None
    notes: list[str] = []
    for _ in range(max_pages):
        page_params = dict(params)
        page_params["page"] = next_page
        exchange = transport.rest_get(path, page_params)
        exchanges.append(exchange)
        http_class = classify_http(exchange)
        last_status = exchange.status
        items = _as_list(exchange.parsed)
        if http_class != "OK" or items is None:
            notes.append(f"page {next_page} class={http_class} status={exchange.status}")
            last_count = None if items is None else len(items)
            link_next = next_page_number(repo_header(exchange, "link"))
            break
        last_count = len(items)
        pages.extend(items)
        link_next = next_page_number(repo_header(exchange, "link"))
        if link_next is None:
            break
        next_page = link_next
    unique, duplicates = merge_unique(pages, key_fn)
    pagination = rest_pagination_status(
        pages_fetched=len(exchanges),
        last_status=last_status,
        last_item_count=last_count,
        next_page=link_next,
        per_page=int(params.get("per_page") or REST_PER_PAGE),
        max_pages=max_pages,
    )
    status = "OK" if pagination["complete"] and classify_http(exchanges[-1]) == "OK" else "INCOMPLETE"
    if any(classify_http(ex) != "OK" for ex in exchanges):
        status = classify_http(exchanges[-1])
        if status == "OK":
            status = "INCOMPLETE"
    return SourceResult(
        name=path,
        exchanges=[ex.id for ex in exchanges],
        status=status,
        http_statuses=[ex.status for ex in exchanges],
        pagination=pagination,
        items=unique,
        duplicates=duplicates,
        notes=notes,
        extra={"raw_item_count": len(pages)},
    )


def collect_ruleset_details(
    transport: Transport,
    config: CollectConfig,
    ruleset_ids: list[int],
) -> SourceResult:
    details = []
    exchanges = []
    notes = []
    statuses = []
    for ruleset_id in ruleset_ids:
        exchange = transport.rest_get(
            f"{_repo_path(config)}/rulesets/{ruleset_id}",
            {"includes_parents": True},
        )
        exchanges.append(exchange)
        http_class = classify_http(exchange)
        statuses.append(exchange.status)
        parsed = exchange.parsed if isinstance(exchange.parsed, dict) else None
        details.append(
            {
                "id": ruleset_id,
                "http_class": http_class,
                "status": exchange.status,
                "exchange_id": exchange.id,
                "body": parsed,
                "bypass_actors_present": bool(parsed and "bypass_actors" in parsed) if parsed else False,
                "rules_present": bool(parsed and parsed.get("rules") is not None) if parsed else False,
            }
        )
        if http_class != "OK":
            notes.append(f"ruleset {ruleset_id} class={http_class}")
        elif parsed and "bypass_actors" not in parsed:
            notes.append(
                f"ruleset {ruleset_id}: bypass_actors omitted. GitHub documents omission unless the "
                "caller has write access to the ruleset. Not treated as empty bypass."
            )
    ok = all(row["http_class"] == "OK" for row in details) and bool(details)
    return SourceResult(
        name="ruleset_details",
        exchanges=[ex.id for ex in exchanges],
        status="OK" if ok else ("EMPTY" if not ruleset_ids else "INCOMPLETE"),
        http_statuses=statuses,
        items=details,
        notes=notes,
        extra={"requested_ids": ruleset_ids},
    )


def collect_branch_protection_rules(transport: Transport, config: CollectConfig) -> SourceResult:
    pages = []
    exchanges = []
    cursor = None
    last_ok = False
    has_next = False
    notes = []
    graphql_errors = []
    for _ in range(config.max_pages):
        exchange = transport.graphql_query(
            BRANCH_PROTECTION_RULES_QUERY,
            {"owner": config.owner, "name": config.repo, "cursor": cursor},
        )
        exchanges.append(exchange)
        http_class = classify_http(exchange)
        if http_class != "OK" and http_class != "GRAPHQL_ERRORS":
            notes.append(f"graphql class={http_class} status={exchange.status}")
            last_ok = False
            break
        parsed = exchange.parsed if isinstance(exchange.parsed, dict) else {}
        if parsed.get("errors"):
            graphql_errors.extend(parsed.get("errors") or [])
        data = parsed.get("data") if isinstance(parsed.get("data"), dict) else {}
        repo = data.get("repository") if isinstance(data.get("repository"), dict) else None
        if repo is None:
            notes.append("repository is null in GraphQL data; not treated as empty rule list")
            last_ok = False
            break
        connection = repo.get("branchProtectionRules") or {}
        nodes = connection.get("nodes") or []
        pages.extend(nodes)
        page_info = connection.get("pageInfo") or {}
        has_next = bool(page_info.get("hasNextPage"))
        last_ok = http_class in {"OK", "GRAPHQL_ERRORS"} and repo is not None
        if not has_next:
            break
        cursor = page_info.get("endCursor")
        if not cursor:
            notes.append("hasNextPage true but endCursor missing")
            last_ok = False
            break
    unique, duplicates = merge_unique(
        pages,
        lambda node: (node or {}).get("id") or (node or {}).get("databaseId") or json.dumps(node, sort_keys=True),
    )
    pagination = graphql_pagination_status(
        pages_fetched=len(exchanges),
        last_ok=last_ok,
        has_next_page=has_next,
        max_pages=config.max_pages,
    )
    status = "OK" if pagination["complete"] and not graphql_errors else "INCOMPLETE"
    if exchanges and classify_http(exchanges[-1]) not in {"OK", "GRAPHQL_ERRORS"}:
        status = classify_http(exchanges[-1])
    return SourceResult(
        name="branchProtectionRules",
        exchanges=[ex.id for ex in exchanges],
        status=status,
        http_statuses=[ex.status for ex in exchanges],
        pagination=pagination,
        items=unique,
        duplicates=duplicates,
        notes=notes,
        extra={
            "graphql_page_size": GRAPHQL_PAGE_SIZE,
            "graphql_errors": graphql_errors,
            "total_count_last_page": (
                (((exchanges[-1].parsed or {}).get("data") or {}).get("repository") or {})
                .get("branchProtectionRules")
                or {}
            ).get("totalCount")
            if exchanges and isinstance(exchanges[-1].parsed, dict)
            else None,
        },
    )


def collect_classic_and_effective(
    transport: Transport,
    config: CollectConfig,
    branches: list[str],
) -> tuple[SourceResult, SourceResult, SourceResult]:
    classic_items = []
    effective_items = []
    meta_items = []
    classic_ex = []
    effective_ex = []
    meta_ex = []
    for branch in branches:
        encoded = branch.replace("/", "%2F")
        classic = transport.rest_get(f"{_repo_path(config)}/branches/{encoded}/protection")
        classic_ex.append(classic)
        http_class = classify_http(classic)
        parsed = classic.parsed if isinstance(classic.parsed, dict) else classic.parsed
        classic_items.append(
            {
                "branch": branch,
                "http_class": http_class,
                "status": classic.status,
                "exchange_id": classic.id,
                "body": parsed if classic.parse_ok else None,
                "message": (parsed or {}).get("message") if isinstance(parsed, dict) else None,
            }
        )
        effective = transport.rest_get(
            f"{_repo_path(config)}/rules/branches/{encoded}",
            {"per_page": config.per_page, "page": 1},
        )
        # Paginate effective rules if needed.
        effective_pages = []
        eff_exchanges = [effective]
        if classify_http(effective) == "OK" and isinstance(effective.parsed, list):
            effective_pages.extend(effective.parsed)
            nxt = next_page_number(repo_header(effective, "link"))
            page = nxt
            while page and len(eff_exchanges) < config.max_pages:
                more = transport.rest_get(
                    f"{_repo_path(config)}/rules/branches/{encoded}",
                    {"per_page": config.per_page, "page": page},
                )
                eff_exchanges.append(more)
                if classify_http(more) != "OK" or not isinstance(more.parsed, list):
                    break
                effective_pages.extend(more.parsed)
                page = next_page_number(repo_header(more, "link"))
        effective_ex.extend(eff_exchanges)
        last_eff = eff_exchanges[-1]
        effective_items.append(
            {
                "branch": branch,
                "http_class": classify_http(last_eff) if classify_http(effective) == "OK" else classify_http(effective),
                "statuses": [ex.status for ex in eff_exchanges],
                "exchange_ids": [ex.id for ex in eff_exchanges],
                "rules": effective_pages if classify_http(effective) == "OK" else None,
                "pagination": rest_pagination_status(
                    pages_fetched=len(eff_exchanges),
                    last_status=last_eff.status,
                    last_item_count=len(last_eff.parsed) if isinstance(last_eff.parsed, list) else None,
                    next_page=next_page_number(repo_header(last_eff, "link")),
                    per_page=config.per_page,
                    max_pages=config.max_pages,
                ),
                "note": (
                    "Effective rules endpoint returns active ruleset rules only. "
                    "It is not a complete substitute for classic branch protection."
                ),
            }
        )
        meta = transport.rest_get(f"{_repo_path(config)}/branches/{encoded}")
        meta_ex.append(meta)
        meta_parsed = meta.parsed if isinstance(meta.parsed, dict) else {}
        meta_items.append(
            {
                "branch": branch,
                "http_class": classify_http(meta),
                "status": meta.status,
                "exchange_id": meta.id,
                "protected_flag": meta_parsed.get("protected") if isinstance(meta_parsed, dict) else None,
                "note": (
                    "Branch JSON 'protected' is auxiliary. It does not distinguish rulesets from classic "
                    "protection and is not used as a complete absence proof."
                ),
            }
        )
    classic_result = SourceResult(
        name="classic_branch_protection_rest",
        exchanges=[ex.id for ex in classic_ex],
        status="COLLECTED",
        http_statuses=[ex.status for ex in classic_ex],
        items=classic_items,
        notes=["REST exact-name protection is separate from GraphQL pattern list."],
    )
    effective_result = SourceResult(
        name="effective_ruleset_rules",
        exchanges=[ex.id for ex in effective_ex],
        status="COLLECTED",
        http_statuses=[ex.status for ex in effective_ex],
        items=effective_items,
    )
    meta_result = SourceResult(
        name="branch_metadata",
        exchanges=[ex.id for ex in meta_ex],
        status="COLLECTED",
        http_statuses=[ex.status for ex in meta_ex],
        items=meta_items,
    )
    return classic_result, effective_result, meta_result


def collect_org_or_enterprise_probe(transport: Transport, config: CollectConfig, owner_type: str | None) -> SourceResult:
    notes = []
    items = []
    exchanges = []
    if owner_type == "User":
        exchange = transport.rest_get(f"orgs/{config.owner}/rulesets", {"per_page": 1, "page": 1})
        exchanges.append(exchange)
        items.append(
            {
                "probe": f"GET /orgs/{config.owner}/rulesets",
                "http_class": classify_http(exchange),
                "status": exchange.status,
                "exchange_id": exchange.id,
                "note": (
                    "Owner type is User. Organization rulesets are not applicable as an org product class "
                    "if this probe is 404. This does not prove enterprise overlays are absent."
                ),
            }
        )
        notes.append("User-owned repository: org ruleset product class probed once; enterprise remains UNKNOWN unless separately evidenced.")
    elif owner_type == "Organization":
        listed = paginate_rest_list(
            transport,
            f"orgs/{config.owner}/rulesets",
            {"per_page": config.per_page},
            key_fn=lambda row: (row or {}).get("id"),
            max_pages=config.max_pages,
        )
        return listed
    else:
        notes.append(f"owner_type={owner_type!r}; org/enterprise inherited rules UNKNOWN")
    return SourceResult(
        name="org_or_enterprise_probe",
        exchanges=[ex.id for ex in exchanges],
        status="PROBED",
        http_statuses=[ex.status for ex in exchanges],
        items=items,
        notes=notes,
        extra={"enterprise": "UNKNOWN_NOT_READ", "owner_type": owner_type},
    )


def target_branches_from_identity(identity: dict[str, Any], frozen_refs: list[str]) -> list[str]:
    branches: list[str] = []
    default_branch = identity.get("default_branch") or "main"
    branches.append(default_branch)
    review_base = (identity.get("review_pr") or {}).get("base_ref")
    if review_base:
        branches.append(review_base)
    for pr in identity.get("open_prs") or []:
        base_ref = pr.get("base_ref")
        if base_ref:
            branches.append(base_ref)
        head_ref = pr.get("head_ref")
        if head_ref:
            branches.append(head_ref)
    for ref in frozen_refs:
        branches.append(ref)
    unique: list[str] = []
    seen = set()
    for branch in branches:
        if branch and branch not in seen:
            seen.add(branch)
            unique.append(branch)
    return unique


def _ruleset_key(row: Any) -> Any:
    if isinstance(row, dict) and row.get("id") is not None:
        return row.get("id")
    return json.dumps(row, sort_keys=True, default=str)


def run_collection(transport: Transport, config: CollectConfig, *, tool_root: Path) -> CollectionBundle:
    started = utc_now()
    environment = capture_environment(tool_root)
    actor, _actor_ex = fetch_actor(transport)
    identity_before = capture_identity(transport, config, "before")
    sources: dict[str, SourceResult] = {}
    parents_true = paginate_rest_list(
        transport,
        f"{_repo_path(config)}/rulesets",
        {"per_page": config.per_page, "includes_parents": True},
        key_fn=_ruleset_key,
        max_pages=config.max_pages,
    )
    sources["rulesets_includes_parents_true"] = parents_true
    parents_false = paginate_rest_list(
        transport,
        f"{_repo_path(config)}/rulesets",
        {"per_page": config.per_page, "includes_parents": False},
        key_fn=_ruleset_key,
        max_pages=config.max_pages,
    )
    sources["rulesets_includes_parents_false"] = parents_false
    ids = []
    for row in parents_true.items + parents_false.items:
        if isinstance(row, dict) and row.get("id") is not None:
            ids.append(int(row["id"]))
    if config.known_ruleset_id not in ids:
        ids.append(int(config.known_ruleset_id))
        parents_true.notes.append(
            f"known ruleset id {config.known_ruleset_id} was not in the list pages; still requesting detail"
        )
    # Preserve order, unique
    seen_ids = []
    for item in ids:
        if item not in seen_ids:
            seen_ids.append(item)
    sources["ruleset_details"] = collect_ruleset_details(transport, config, seen_ids)
    sources["branchProtectionRules"] = collect_branch_protection_rules(transport, config)
    branches = target_branches_from_identity(identity_before, config.frozen_refs)
    classic, effective, meta = collect_classic_and_effective(transport, config, branches)
    sources["classic_branch_protection_rest"] = classic
    sources["effective_ruleset_rules"] = effective
    sources["branch_metadata"] = meta
    sources["org_or_enterprise_probe"] = collect_org_or_enterprise_probe(
        transport, config, identity_before.get("owner_type")
    )
    identity_after = capture_identity(transport, config, "after")
    drift = compare_identity(identity_before, after=identity_after)
    # Also compare ruleset ids and BPR ids if both sides collected inside this same run
    # (identity drift only; rule-body drift is compared from before/after identity, not mixed).
    gaps = []
    for name, source in sources.items():
        if source.status not in {"OK", "COLLECTED", "PROBED"}:
            gaps.append({"source": name, "status": source.status, "notes": source.notes})
        if source.pagination and not source.pagination.get("complete", True):
            if source.status == "OK":
                continue
            gaps.append({"source": name, "status": "PAGINATION_INCOMPLETE", "pagination": source.pagination})
    finished = utc_now()
    return CollectionBundle(
        config=config,
        started_at=started,
        finished_at=finished,
        environment=environment,
        actor=actor,
        identity_before=identity_before,
        identity_after=identity_after,
        drift=drift,
        sources=sources,
        target_branches=branches,
        gaps=gaps,
        documentation_basis=DOCUMENTATION_BASIS,
    )
