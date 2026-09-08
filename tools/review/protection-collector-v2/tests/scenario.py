from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from lib.redact import redact_headers, redact_text
from lib.safety import assert_graphql_query, assert_rest_method
from lib.transport import FakeTransport, HttpExchange, utc_now

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"

EXPECTED_MAIN = "22665d7fa9274dfc05de043c8e9663e24e75087e"
REVIEW_HEAD = "de2f5c0fd055e418d0b6d806f994b52baa743544"
REVIEW_TREE = "1b443a620670216968b95cc43de96397550c24f2"
LEAK_TOKEN = "gho_SYNTHETIC_FIXTURE"


def jload(relative: str) -> Any:
    path = FIXTURES / relative
    if path.suffix == ".txt":
        return path.read_text(encoding="utf-8")
    return json.loads(path.read_text(encoding="utf-8"))


def commit_payload(sha: str, tree: str) -> dict[str, Any]:
    return {"sha": sha, "commit": {"tree": {"sha": tree}, "message": "fixture"}}


class ScriptedGithub(FakeTransport):
    """Offline GitHub that still enforces GET-only REST and GraphQL queries."""

    def __init__(self, mode: str = "conflict_non_main") -> None:
        super().__init__()
        self.mode = mode
        self.pr_reads = 0
        self.graphql_reads = 0
        self.ruleset_list_pages: dict[str, int] = {}

    def rest_get(self, path: str, params: dict[str, Any] | None = None) -> HttpExchange:
        assert_rest_method("GET")
        params = params or {}
        status, body, headers = self._route_rest(path, params)
        if isinstance(body, (dict, list)):
            raw = json.dumps(body)
        else:
            raw = str(body)
        # Inject a credential header that must never be copied into evidence.
        headers = {
            "Authorization": f"Bearer {LEAK_TOKEN}",
            "X-OAuth-Scopes": "repo, workflow, gist, read:org",
            "X-RateLimit-Remaining": "4999",
            "Content-Type": "application/json",
            **headers,
        }
        page = None
        if "page" in params:
            try:
                page = int(params["page"])
            except (TypeError, ValueError):
                page = None
        query = urlencode(
            {k: v if not isinstance(v, bool) else ("true" if v else "false") for k, v in params.items()},
            doseq=True,
        )
        endpoint = path if not query else f"{path}?{query}"
        return self._materialize(
            {
                "status": status,
                "body": raw,
                "headers": headers,
                "page": page,
            },
            kind="rest",
            method="GET",
            endpoint=endpoint,
        )

    def graphql_query(self, query: str, variables: dict[str, Any] | None = None) -> HttpExchange:
        assert_graphql_query(query)
        self.graphql_reads += 1
        if self.mode == "graphql_403":
            body = jload("http/403.json")
            return self._materialize(
                {"status": 403, "body": json.dumps(body), "headers": {"X-RateLimit-Remaining": "10"}},
                kind="graphql",
                method="POST",
                endpoint="graphql",
            )
        if self.mode == "bpr_empty":
            payload = jload("graphql/bpr-page1.json")
            payload["data"]["repository"]["branchProtectionRules"] = {
                "totalCount": 0,
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [],
            }
            return self._materialize(
                {"status": 200, "body": json.dumps(payload)},
                kind="graphql",
                method="POST",
                endpoint="graphql",
            )
        if self.graphql_reads == 1:
            payload = jload("graphql/bpr-page1.json")
        else:
            payload = jload("graphql/bpr-page2.json")
        return self._materialize(
            {"status": 200, "body": json.dumps(payload)},
            kind="graphql",
            method="POST",
            endpoint="graphql",
        )

    def _route_rest(self, path: str, params: dict[str, Any]) -> tuple[int, Any, dict[str, str]]:
        if self.mode == "auth_401" and path == "user":
            return 401, jload("http/401.json"), {}
        if path == "user":
            return 200, jload("http/user.json"), {}
        if path == "rate_limit":
            return 200, {"resources": {"core": {"remaining": 4999, "limit": 5000}}}, {}
        if path.endswith("/multi-venue-grid-engine") and path.startswith("repos/"):
            return 200, jload("http/repo.json"), {}
        if path.endswith("/pulls/11"):
            self.pr_reads += 1
            if self.mode == "drift" and self.pr_reads >= 2:
                return 200, jload("identity/after-drift.json"), {}
            return 200, jload("http/pr11.json"), {}
        if path.endswith("/pulls"):
            return 200, jload("http/open-prs.json"), {}
        if '/git/ref/heads/' in path:
            from tests.test_collect_offline import FROZEN
            name = path.split('/git/ref/heads/')[1]
            oid = EXPECTED_MAIN if name == 'main' else FROZEN.get(name, REVIEW_HEAD)
            return 200, {'ref': 'refs/heads/' + name, 'object': {'type': 'commit', 'sha': oid}}, {}
        from tests.test_collect_offline import FROZEN
        if '/commits/' in path and path.rsplit('/', 1)[1] in FROZEN.values():
            return 200, commit_payload(path.rsplit('/', 1)[1], 'c' * 40), {}
        if path.endswith(f"/commits/{EXPECTED_MAIN}"):
            return 200, commit_payload(EXPECTED_MAIN, "6981c1124524895273fb09b53d769ca9dbb722bc"), {}
        if path.endswith(f"/commits/{REVIEW_HEAD}"):
            return 200, commit_payload(REVIEW_HEAD, REVIEW_TREE), {}
        if path.endswith("/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"):
            return 200, commit_payload("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), {}
        if path.endswith("/rulesets") and "orgs/" in path:
            return 404, jload("http/404.json"), {}
        if path.endswith("/rulesets"):
            return self._ruleset_list(params)
        if "/rulesets/" in path:
            return self._ruleset_detail(path)
        if path.endswith("/protection"):
            return self._classic(path)
        if "/rules/branches/" in path:
            if self.mode == "malformed_effective":
                return 200, jload("http/malformed.txt"), {}
            return 200, [], {}
        if "/branches/" in path:
            branch = path.rsplit("/branches/", 1)[-1]
            return 200, {"name": branch.replace("%2F", "/"), "protected": False}, {}
        raise LookupError(path)

    def _ruleset_list(self, params: dict[str, Any]) -> tuple[int, Any, dict[str, str]]:
        parents = str(params.get("includes_parents", "true")).lower()
        page = int(params.get("page") or 1)
        key = f"{parents}:{page}"
        if self.mode == "list_403":
            return 403, jload("http/403.json"), {}
        if self.mode == "rate_limit" and page == 2:
            return 403, jload("http/429.json"), {"Retry-After": "30", "X-RateLimit-Remaining": "0"}
        if self.mode == "interrupt" and page == 2:
            return 403, jload("http/403.json"), {}
        if parents in {"true", "1"}:
            if page == 1:
                headers = {
                    "Link": '<https://api.github.com/repos/danny0971haha/multi-venue-grid-engine/rulesets?page=2&includes_parents=true>; rel="next"'
                }
                page_body = jload("rest/rulesets-page1.json")
                if self.mode == "single_page":
                    return 200, page_body, {}
                return 200, page_body, headers
            if self.mode == "duplicate":
                return 200, jload("rest/rulesets-page2-duplicate.json"), {}
            items = jload("rest/rulesets-page2.json")
            if self.mode == "bpr_empty":
                items = [r for r in items if r.get("source_type") == "Repository"]
            return 200, items, {}
        # includes_parents=false: single page local only
        return 200, jload("rest/rulesets-page1.json"), {}

    def _ruleset_detail(self, path: str) -> tuple[int, Any, dict[str, str]]:
        ruleset_id = path.rsplit("/", 1)[-1]
        mapping = {
            "21580900": "rest/ruleset-active-main.json",
            "10000001": "rest/ruleset-evaluate.json",
            "10000002": "rest/ruleset-disabled.json",
            "30000001": "rest/ruleset-inherited.json",
            "40000001": "rest/ruleset-same-context-app-a.json",
            "40000002": "rest/ruleset-same-context-app-b.json",
        }
        if self.mode == "detail_404" and ruleset_id == "21580900":
            return 404, jload("http/404.json"), {}
        relative = mapping.get(ruleset_id)
        if not relative:
            return 404, jload("http/404.json"), {}
        return 200, jload(relative), {}

    def _classic(self, path: str) -> tuple[int, Any, dict[str, str]]:
        branch = path.split("/branches/")[1].split("/protection")[0].replace("%2F", "/")
        if self.mode == "classic_403":
            return 403, jload("http/403.json"), {}
        if branch == "fix/multi-format-evidence-20260905" and self.mode == "conflict_non_main":
            return 200, jload("rest/classic-non-main-200.json"), {}
        return 404, jload("http/404-branch-not-protected.json"), {}
