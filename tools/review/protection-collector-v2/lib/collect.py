"""Live and offline read-only collection of GitHub protection sources."""

from __future__ import annotations

import json
import platform
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

from .validation import obj, sha, connection_errors, bpr_errors, ruleset_errors, pr_errors, rule_errors, effective_rule_errors

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
from .pagination import graphql_pagination_status, merge_unique, next_page_number, rest_pagination_status, parse_link_rels, page_from_url
from .redact import redact_text
from .transport import HttpExchange, Transport, utc_now

BRANCH_PROTECTION_RULES_QUERY = """
query ProtectionCollectorV2BranchProtectionRules($owner: String!, $name: String!, $cursor: String) {
  viewer { login databaseId }
  rateLimit { limit remaining resetAt used }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    viewerPermission
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
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            actor {
              __typename
              ... on User { id login }
              ... on Team { id slug name }
              ... on App { id databaseId slug name }
            }
          }
        }
        bypassPullRequestAllowances(first: 20) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            actor {
              __typename
              ... on User { id login }
              ... on Team { id slug name }
              ... on App { id databaseId slug name }
            }
          }
        }
        pushAllowances(first: 20) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            actor {
              __typename
              ... on User { id login }
              ... on Team { id slug name }
              ... on App { id databaseId slug name }
            }
          }
        }
        reviewDismissalAllowances(first: 20) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            actor {
              __typename
              ... on User { id login }
              ... on Team { id slug name }
              ... on App { id databaseId slug name }
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
    expected_frozen_refs: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        refs = []
        for entry in self.frozen_refs:
            ref, sep, expected = entry.partition("=")
            if sep:
                if not sha(expected):
                    raise ValueError("frozen ref requires a full commit SHA")
                self.expected_frozen_refs[ref] = expected
            refs.append(ref)
        self.frozen_refs = refs


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
        "endpoint_required_github_permissions": accepted_permissions,
        "accepted_headers_are_caller_permissions": False,
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
    root = _repo_path(config)
    exchanges = []
    issues = []

    def get(path):
        ex = transport.rest_get(path)
        exchanges.append(ex)
        if classify_http(ex) != "OK":
            issues.append({"endpoint": path, "class": classify_http(ex), "exchange_id": ex.id})
            return {}, ex
        if not isinstance(ex.parsed, dict):
            issues.append({"endpoint": path, "class": "MALFORMED", "exchange_id": ex.id})
            return {}, ex
        return ex.parsed, ex

    def commit(observed_sha):
        if not sha(observed_sha):
            issues.append({"class": "MISSING_OBSERVED_SHA", "value": observed_sha})
            return None
        body, ex = get(f"{root}/commits/{observed_sha}")
        tree = _tree_sha_from_commit(body)
        if body.get("sha") != observed_sha or not sha(tree):
            issues.append({"class": "COMMIT_IDENTITY_INCOMPLETE_OR_MISMATCH", "exchange_id": ex.id})
            return None
        return tree

    def ref(name, expected):
        body, ex = get(f"{root}/git/ref/heads/{quote(name, safe='/')}")
        observed = obj(body.get("object")).get("sha")
        if body.get("ref") != f"refs/heads/{name}" or obj(body.get("object")).get("type") != "commit":
            issues.append({"class": "REF_IDENTITY_INCOMPLETE_OR_MISMATCH", "ref": name, "exchange_id": ex.id})
            observed = None
        return {"ref": name, "sha": observed, "tree": commit(observed),
                "expected_sha": expected, "matches_expected": observed == expected if expected else None,
                "exchange_id": ex.id}

    repo, repo_ex = get(root)
    owner = obj(repo.get("owner"))
    if repo.get("full_name") != f"{config.owner}/{config.repo}" or owner.get("login") != config.owner or owner.get("type") not in ("User", "Organization") or not repo.get("default_branch"):
        issues.append({"class": "REPOSITORY_IDENTITY_INCOMPLETE_OR_MISMATCH"})
    pr, pr_ex = get(f"{root}/pulls/{config.review_pr}")
    issues.extend({"class": e} for e in pr_errors(pr))
    if pr.get("number") != config.review_pr:
        issues.append({"class": "PR_NUMBER_MISMATCH"})
    head, base = obj(pr.get("head")), obj(pr.get("base"))
    prs = paginate_rest_list(transport, f"{root}/pulls", {"state": "open", "per_page": config.per_page},
                            key_fn=lambda p: p.get("number"), max_pages=config.max_pages,
                            validate_item=pr_errors)
    if prs.status != "OK":
        issues.append({"class": "OPEN_PRS_INCOMPLETE", "source": asdict(prs)})
    main = ref("main", config.expected_main)
    head_tree, base_tree = commit(head.get("sha")), commit(base.get("sha"))
    base_ref = ref(base["ref"], config.expected_main if base["ref"] == "main" else None) if isinstance(base.get("ref"), str) else {}
    frozen = {name: ref(name, config.expected_frozen_refs.get(name)) for name in config.frozen_refs}
    get("rate_limit")
    match = {"head": head.get("sha") == config.review_head,
             "tree": head_tree == config.review_tree if head_tree else None,
             "main": main["matches_expected"],
             "base_ref": base.get("ref") == "main",
             "base_sha": base.get("sha") == config.expected_main,
             "base_ref_sha": base_ref.get("sha") == base.get("sha") if base_ref.get("sha") else None}
    match.update({f"frozen:{name}": item["matches_expected"] for name, item in frozen.items()})
    if not all(v is True for v in match.values()):
        issues.append({"class": "EXPECTED_IDENTITY_MISMATCH_OR_UNVERIFIED", "match": match})
    return {
        "label": label, "captured_at": utc_now(), "exchange_ids": [e.id for e in exchanges] + prs.exchanges,
        "http_classes": {e.endpoint: classify_http(e) for e in exchanges},
        "complete": not issues, "issues": issues,
        "owner_login": owner.get("login"), "owner_type": owner.get("type"),
        "repository_full_name": repo.get("full_name"), "repository_http_class": classify_http(repo_ex),
        "repository_permissions": repo.get("permissions"), "repository_exchange_id": repo_ex.id,
        "fork": repo.get("fork"), "default_branch": repo.get("default_branch"),
        "visibility": repo.get("visibility"),
        "review_pr": {"number": pr.get("number"), "state": pr.get("state"), "draft": pr.get("draft"),
                      "head_ref": head.get("ref"), "head_sha": head.get("sha"), "head_tree": head_tree,
                      "base_ref": base.get("ref"), "base_sha": base.get("sha"), "base_tree": base_tree},
        "main": main, "review_base_ref": base_ref, "frozen_refs": frozen,
        "open_prs": [{"number": p.get("number"), "head_ref": obj(p.get("head")).get("ref"),
                      "head_sha": obj(p.get("head")).get("sha"), "base_ref": obj(p.get("base")).get("ref"),
                      "base_sha": obj(p.get("base")).get("sha")} for p in prs.items if isinstance(p, dict)],
        "open_prs_pagination": prs.pagination, "open_prs_source": asdict(prs),
        "expected": {"review_head": config.review_head, "review_tree": config.review_tree,
                     "expected_main": config.expected_main, "frozen_refs": config.expected_frozen_refs}, "match": match,
    }


def repo_header(exchange: HttpExchange, name: str) -> str | None:
    lower = name.lower()
    for key, value in exchange.headers.items():
        if key.lower() == lower:
            return value
    return None


def compare_identity(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    changed = []
    def substantive(value):
        if isinstance(value, dict):
            return {k: substantive(v) for k, v in value.items() if k != "exchange_id"}
        return value
    for key in ("main", "review_pr", "review_base_ref", "frozen_refs", "owner_login", "owner_type",
                "repository_full_name", "fork", "default_branch", "open_prs", "repository_permissions"):
        left, right = substantive(before.get(key)), substantive(after.get(key))
        if left != right:
            changed.append({"field": key, "before": left, "after": right})
    return {"drift_detected": bool(changed), "changed": changed,
            "identity_verified": before.get("complete") is True and after.get("complete") is True and not changed,
            "before_issues": before.get("issues"), "after_issues": after.get("issues"),
            "note": "Separate before/after observations; stable refs do not prove atomic protection settings."}


def paginate_rest_list(transport: Transport, path: str, params: dict[str, Any], *,
                       key_fn, max_pages: int, validate_item=None) -> SourceResult:
    exchanges, items, notes = [], [], []
    page, next_page, last_count = 1, 1, None
    seen_pages = set()
    terminal = False
    status = "INCOMPLETE"
    for _ in range(max_pages):
        if page in seen_pages:
            notes.append("repeated page")
            break
        seen_pages.add(page)
        ex = transport.rest_get(path, {**params, "page": page})
        exchanges.append(ex)
        status = classify_http(ex)
        if status != "OK":
            notes.append(f"page {page}: {status}")
            break
        if not isinstance(ex.parsed, list):
            status = "MALFORMED"
            notes.append(f"page {page}: expected array, not empty by default")
            break
        last_count = len(ex.parsed)
        for item in ex.parsed:
            errors = validate_item(item) if validate_item else ([] if isinstance(item, dict) else ["invalid item"])
            notes.extend(f"page {page}: {e}" for e in errors)
            items.append(item)
        link = repo_header(ex, "link")
        rels = parse_link_rels(link)
        next_page = next_page_number(link)
        if link and not rels:
            notes.append("malformed Link header")
            break
        if "next" in rels and (next_page is None or next_page <= page):
            notes.append("invalid/repeated/non-forward next page")
            break
        if next_page is None and 'last' in rels and (page_from_url(rels['last']) is None or page_from_url(rels['last']) > page):
            notes.append("last page indicates missing next link")
            break
        if next_page is None:
            # A documented Link-free array is a terminal page, including [] and an exact full page.
            terminal = True
            break
        page = next_page
    unique, duplicates = merge_unique(items, key_fn)
    if duplicates:
        notes.append("duplicate identities; pagination is not a consistent complete export")
    complete = terminal and status == "OK" and not notes
    pagination = {"complete": complete, "pages_fetched": len(exchanges), "next_page": next_page,
                  "last_item_count": last_count, "truncated_by_max_pages": not terminal and len(exchanges) >= max_pages,
                  "interrupted": not terminal, "validated_empty_collection": complete and not items}
    return SourceResult(name=path, exchanges=[e.id for e in exchanges],
                        status="OK" if complete else (status if status != "OK" else "INCOMPLETE"),
                        http_statuses=[e.status for e in exchanges], pagination=pagination,
                        items=unique, duplicates=duplicates, notes=notes,
                        extra={"raw_item_count": len(items)})


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
        shape_errors = ruleset_errors(parsed, ruleset_id) if http_class == "OK" else []
        details.append(
            {
                "id": ruleset_id,
                "http_class": http_class,
                "complete": http_class == "OK" and not shape_errors,
                "shape_errors": shape_errors,
                "status": exchange.status,
                "exchange_id": exchange.id,
                "body": parsed,
                "bypass_actors_present": bool(parsed and "bypass_actors" in parsed) if parsed else False,
                "rules_present": bool(parsed and parsed.get("rules") is not None) if parsed else False,
            }
        )
        notes.extend(f"ruleset {ruleset_id}: {error}" for error in shape_errors)
        if http_class != "OK":
            notes.append(f"ruleset {ruleset_id} class={http_class}")
        elif parsed and "bypass_actors" not in parsed:
            notes.append(
                f"ruleset {ruleset_id}: bypass_actors omitted. GitHub documents omission unless the "
                "caller has write access to the ruleset. Not treated as empty bypass."
            )
    ok = all(row["complete"] for row in details)
    return SourceResult(
        name="ruleset_details",
        exchanges=[ex.id for ex in exchanges],
        status="OK" if ok else "INCOMPLETE",
        http_statuses=statuses,
        items=details,
        notes=notes,
        extra={"requested_ids": ruleset_ids},
    )


def collect_branch_protection_rules(transport: Transport, config: CollectConfig) -> SourceResult:
    pages, exchanges, notes, graphql_errors = [], [], [], []
    cursor, total, viewer_permission = None, None, None
    seen_cursors = set()
    terminal = False
    status = "INCOMPLETE"
    for _ in range(config.max_pages):
        ex = transport.graphql_query(BRANCH_PROTECTION_RULES_QUERY,
                                    {"owner": config.owner, "name": config.repo, "cursor": cursor})
        exchanges.append(ex)
        status = classify_http(ex)
        if status not in ("OK", "GRAPHQL_ERRORS"):
            notes.append(f"GraphQL {status}")
            break
        parsed = obj(ex.parsed)
        if parsed.get("errors"):
            graphql_errors.append(parsed["errors"])
        repo = obj(obj(parsed.get("data")).get("repository"))
        if repo.get("nameWithOwner") != f"{config.owner}/{config.repo}":
            notes.append("GraphQL repository identity missing/mismatch")
        viewer_permission = repo.get("viewerPermission")
        conn = repo.get("branchProtectionRules")
        errors = connection_errors(conn)
        # Keep observed nodes even from partial data, but never complete that source.
        nodes = obj(conn).get("nodes")
        if isinstance(nodes, list):
            pages.extend(nodes)
            for node in nodes:
                notes.extend(bpr_errors(node))
        if errors:
            notes.extend(errors)
            break
        count = conn['totalCount']
        if total is not None and count != total:
            notes.append("totalCount moved across pages")
        total = count
        info = conn['pageInfo']
        if not info['hasNextPage']:
            terminal = True
            break
        cursor = info['endCursor']
        if cursor in seen_cursors:
            notes.append("repeated cursor")
            break
        seen_cursors.add(cursor)
        if graphql_errors:
            break
    unique, duplicates = merge_unique(pages, lambda n: obj(n).get('id'))
    if duplicates:
        notes.append("duplicate rule identities")
    if total is not None and len(unique) != total:
        notes.append("totalCount does not equal unique rule count")
    complete = terminal and status == "OK" and not notes and not graphql_errors
    return SourceResult(name="branchProtectionRules", exchanges=[e.id for e in exchanges],
        status="OK" if complete else (status if status not in ("OK", "GRAPHQL_ERRORS") else "INCOMPLETE"),
        http_statuses=[e.status for e in exchanges], items=unique, duplicates=duplicates, notes=notes,
        pagination={"complete": complete, "pages_fetched": len(exchanges),
                    "truncated_by_max_pages": not terminal and len(exchanges) >= config.max_pages,
                    "validated_empty_collection": complete and not unique},
        extra={"graphql_errors": graphql_errors, "total_count_last_page": total,
               "viewer_permission": viewer_permission,
               "allowance_policy": "First 20 per connection; any unfinished/invalid allowance makes coverage incomplete.",
               "matching_refs_policy": "Count only; not a full ref list and not used to prove absence."})


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
        encoded = quote(branch, safe="")
        classic = transport.rest_get(f"{_repo_path(config)}/branches/{encoded}/protection")
        classic_ex.append(classic)
        http_class = classify_http(classic)
        parsed = classic.parsed
        if http_class == "OK" and (not isinstance(parsed, dict) or not isinstance(parsed.get("url"), str) or not isinstance(parsed.get("enforce_admins"), dict)):
            http_class = "MALFORMED"
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
        effective = paginate_rest_list(
            transport, f"{_repo_path(config)}/rules/branches/{encoded}", {"per_page": config.per_page},
            key_fn=lambda r: (r.get("ruleset_id"), r.get("type")),
            max_pages=config.max_pages, validate_item=effective_rule_errors)
        effective_items.append({"branch": branch, "http_class": effective.status,
            "statuses": effective.http_statuses, "exchange_ids": effective.exchanges,
            "rules": effective.items if effective.status == "OK" else None,
            "observed_rules": effective.items, "pagination": effective.pagination,
            "duplicates": effective.duplicates, "notes": effective.notes,
            "note": "Active ruleset rules only; not classic branch protection."})
        effective_ex.extend(effective.exchanges)
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
        exchanges=effective_ex,
        status="OK" if all(i["http_class"] == "OK" for i in effective_items) else "INCOMPLETE",
        http_statuses=[code for i in effective_items for code in i["statuses"]],
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


def collect_org_or_enterprise_probe(transport: Transport, config: CollectConfig, identity: dict) -> SourceResult:
    # Product scope + observed ownership, never an unauthorized org endpoint 404.
    from .constants import APPLICABILITY_DOCUMENTATION
    user_root = (identity.get("repository_http_class") == "OK" and
                 identity.get("repository_full_name") == f"{config.owner}/{config.repo}" and
                 identity.get("owner_login") == config.owner and identity.get("owner_type") == "User" and
                 identity.get("fork") is False)
    if user_root:
        return SourceResult(name="org_or_enterprise_probe", exchanges=[], status="NOT_APPLICABLE",
            http_statuses=[], extra={"organization": "NOT_APPLICABLE", "enterprise": "NOT_APPLICABLE",
            "ownership_exchange_id": identity.get("repository_exchange_id"),
            "documentation": APPLICABILITY_DOCUMENTATION,
            "basis": "Personal-owned non-fork repository; org/enterprise targeting is scoped to organizations. Fork inheritance explicitly excluded by observed fork=false."})
    return SourceResult(name="org_or_enterprise_probe", exchanges=[], status="INCOMPLETE", http_statuses=[],
        notes=["Org/enterprise product coverage not established; includes_parents export retained separately. Unknown ownership/fork ancestry is not a non-applicability proof."],
        extra={"organization": "UNKNOWN", "enterprise": "UNKNOWN_NOT_READ", "documentation": APPLICABILITY_DOCUMENTATION})


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
        validate_item=lambda row: ruleset_errors(row, detail=False),
    )
    sources["rulesets_includes_parents_true"] = parents_true
    parents_false = paginate_rest_list(
        transport,
        f"{_repo_path(config)}/rulesets",
        {"per_page": config.per_page, "includes_parents": False},
        key_fn=_ruleset_key,
        max_pages=config.max_pages,
        validate_item=lambda row: ruleset_errors(row, detail=False),
    )
    sources["rulesets_includes_parents_false"] = parents_false
    ids = []
    for row in parents_true.items + parents_false.items:
        if isinstance(row, dict) and type(row.get("id")) is int:
            ids.append(row["id"])
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
        transport, config, identity_before
    )
    product = sources["org_or_enterprise_probe"]
    if product.status == "NOT_APPLICABLE" and any(
        obj(row).get("source_type") in ("Organization", "Enterprise")
        for row in parents_true.items + parents_false.items
    ):
        product.status = "INCOMPLETE"
        product.extra.update(organization="UNKNOWN", enterprise="UNKNOWN_NOT_READ")
        product.notes.append("Inherited source contradicts personal non-fork ownership; reconcile before non-applicability.")
    identity_after = capture_identity(transport, config, "after")
    drift = compare_identity(identity_before, after=identity_after)
    # Protection sources are sequential reads, not an atomic settings snapshot.
    gaps = []
    for identity in (identity_before, identity_after):
        if not identity["complete"]:
            gaps.append({"source": "identity_" + identity["label"], "status": "INCOMPLETE", "issues": identity["issues"]})
    if drift["drift_detected"]:
        gaps.append({"source": "identity", "status": "DRIFT"})
    for name, source in sources.items():
        if source.status not in {"OK", "COLLECTED", "NOT_APPLICABLE"}:
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
