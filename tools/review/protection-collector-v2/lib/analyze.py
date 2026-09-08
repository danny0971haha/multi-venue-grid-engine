"""Derived analysis. Never treats HTTP errors or incomplete pages as 'no rules'."""

from __future__ import annotations

from typing import Any

from .collect import CollectionBundle, SourceResult
from .patterns import pattern_scope, ref_for_branch, ruleset_applies_to_ref, ruleset_non_default_possible


ABSENCE_FORBIDDEN_CLASSES = {
    "AUTH_FAILED",
    "FORBIDDEN",
    "NOT_FOUND",
    "RATE_LIMITED",
    "MALFORMED",
    "TRANSPORT_OR_SERVER_ERROR",
    "HTTP_ERROR",
    "GRAPHQL_ERRORS",
    "INCOMPLETE",
    "EMPTY",
}


def _required_checks_from_ruleset(body: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(body, dict):
        return []
    checks = []
    for rule in body.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        if rule.get("type") != "required_status_checks":
            continue
        params = rule.get("parameters") or {}
        for check in params.get("required_status_checks") or []:
            if not isinstance(check, dict):
                continue
            checks.append(
                {
                    "context": check.get("context"),
                    "integration_id": check.get("integration_id"),
                    "strict": params.get("strict_required_status_checks_policy"),
                }
            )
    return checks


def _classic_checks(node: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    detailed = node.get("requiredStatusChecks") or []
    if detailed:
        for item in detailed:
            if not isinstance(item, dict):
                continue
            app = item.get("app") or {}
            out.append(
                {
                    "context": item.get("context"),
                    "app_database_id": (app or {}).get("databaseId") if isinstance(app, dict) else None,
                    "app_slug": (app or {}).get("slug") if isinstance(app, dict) else None,
                    "app_name": (app or {}).get("name") if isinstance(app, dict) else None,
                }
            )
        return out
    for context in node.get("requiredStatusCheckContexts") or []:
        out.append({"context": context, "app_database_id": None, "app_slug": None, "app_name": None})
    return out


def _source_complete(source: SourceResult) -> bool:
    if source.status not in {"OK", "COLLECTED", "PROBED"}:
        return False
    if source.pagination and source.pagination.get("complete") is False:
        return False
    return True


def analyze(bundle: CollectionBundle) -> dict[str, Any]:
    config = bundle.config
    default_branch = bundle.identity_before.get("default_branch") or "main"
    expected = config.expected_context
    details = bundle.sources.get("ruleset_details")
    list_true = bundle.sources.get("rulesets_includes_parents_true")
    list_false = bundle.sources.get("rulesets_includes_parents_false")
    bpr = bundle.sources.get("branchProtectionRules")
    classic_rest = bundle.sources.get("classic_branch_protection_rest")
    effective = bundle.sources.get("effective_ruleset_rules")

    ruleset_rows = []
    for item in (details.items if details else []):
        body = item.get("body") if isinstance(item, dict) else None
        http_class = item.get("http_class")
        if http_class != "OK" or not isinstance(body, dict):
            ruleset_rows.append(
                {
                    "id": item.get("id"),
                    "http_class": http_class,
                    "conclusion": "UNKNOWN",
                    "reason": "detail not OK; not treated as absent",
                }
            )
            continue
        checks = _required_checks_from_ruleset(body)
        scope = ruleset_non_default_possible(body.get("conditions"), default_branch)
        applies_main = ruleset_applies_to_ref(
            body.get("conditions"), ref_for_branch(default_branch), default_branch
        )
        matching_expected = [c for c in checks if c.get("context") == expected]
        ruleset_rows.append(
            {
                "id": body.get("id"),
                "name": body.get("name"),
                "enforcement": body.get("enforcement"),
                "source_type": body.get("source_type"),
                "source": body.get("source"),
                "include": ((body.get("conditions") or {}).get("ref_name") or {}).get("include"),
                "exclude": ((body.get("conditions") or {}).get("ref_name") or {}).get("exclude"),
                "bypass_actors_present": "bypass_actors" in body,
                "bypass_actors": body.get("bypass_actors") if "bypass_actors" in body else "OMITTED_UNKNOWN",
                "required_checks": checks,
                "expected_context_bindings": matching_expected,
                "non_default_scope": scope,
                "applies_to_default": applies_main,
                "http_class": http_class,
            }
        )

    bpr_rows = []
    for node in (bpr.items if bpr else []):
        if not isinstance(node, dict):
            continue
        pattern = node.get("pattern")
        scope = pattern_scope(pattern, kind="classic", default_branch=default_branch)
        checks = _classic_checks(node)
        matching = [c for c in checks if c.get("context") == expected]
        allowances_truncated = False
        for key in (
            "bypassForcePushAllowances",
            "bypassPullRequestAllowances",
            "pushAllowances",
            "reviewDismissalAllowances",
        ):
            info = ((node.get(key) or {}).get("pageInfo") or {})
            if info.get("hasNextPage"):
                allowances_truncated = True
        bpr_rows.append(
            {
                "id": node.get("id"),
                "database_id": node.get("databaseId"),
                "pattern": pattern,
                "scope": scope,
                "requires_status_checks": node.get("requiresStatusChecks"),
                "required_checks": checks,
                "expected_context_bindings": matching,
                "is_admin_enforced": node.get("isAdminEnforced"),
                "matching_refs_total": ((node.get("matchingRefs") or {}).get("totalCount")),
                "matching_refs_not_fully_listed": True,
                "allowances_truncated": allowances_truncated,
            }
        )

    non_main_context_hits = []
    for row in ruleset_rows:
        if row.get("conclusion") == "UNKNOWN":
            continue
        if row.get("enforcement") not in {"active", "evaluate", "disabled"}:
            continue
        if row.get("expected_context_bindings") and row.get("non_default_scope") == "can_match_non_default":
            non_main_context_hits.append(
                {
                    "source": "ruleset",
                    "id": row.get("id"),
                    "enforcement": row.get("enforcement"),
                    "include": row.get("include"),
                    "bindings": row.get("expected_context_bindings"),
                }
            )
        if row.get("expected_context_bindings") and row.get("non_default_scope") == "unknown":
            non_main_context_hits.append(
                {
                    "source": "ruleset",
                    "id": row.get("id"),
                    "enforcement": row.get("enforcement"),
                    "scope": "unknown",
                    "bindings": row.get("expected_context_bindings"),
                }
            )
    for row in bpr_rows:
        if row.get("expected_context_bindings") and row.get("scope") in {"can_match_non_default", "unknown"}:
            non_main_context_hits.append(
                {
                    "source": "classic_branchProtectionRule",
                    "pattern": row.get("pattern"),
                    "scope": row.get("scope"),
                    "bindings": row.get("expected_context_bindings"),
                }
            )

    # Effective endpoint: per-branch, ruleset-only, active only.
    effective_context = []
    for item in (effective.items if effective else []):
        rules = item.get("rules")
        if rules is None:
            effective_context.append(
                {
                    "branch": item.get("branch"),
                    "http_class": item.get("http_class"),
                    "expected_context": "UNKNOWN",
                    "reason": "effective rules not OK; not treated as empty",
                }
            )
            continue
        hits = []
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            params = rule.get("parameters") or {}
            for check in params.get("required_status_checks") or []:
                if isinstance(check, dict) and check.get("context") == expected:
                    hits.append(check)
            # Some effective payloads use type + context at top level.
            if rule.get("type") == "required_status_checks":
                for check in params.get("required_status_checks") or []:
                    pass
        effective_context.append(
            {
                "branch": item.get("branch"),
                "http_class": item.get("http_class"),
                "pagination": item.get("pagination"),
                "expected_context_hits": hits,
                "rule_count": len(rules),
            }
        )

    lists_complete = bool(list_true and _source_complete(list_true) and list_false and _source_complete(list_false))
    details_complete = bool(details and details.status == "OK")
    bpr_complete = bool(bpr and _source_complete(bpr) and bpr.status == "OK")
    classic_rest_complete = bool(classic_rest) and all(
        row.get("http_class") in {"OK", "CLASSIC_NOT_PROTECTED_MESSAGE"} for row in (classic_rest.items if classic_rest else [])
    )
    # 404 without the specific message remains incomplete.
    if classic_rest:
        for row in classic_rest.items:
            if row.get("http_class") in ABSENCE_FORBIDDEN_CLASSES and row.get("http_class") != "CLASSIC_NOT_PROTECTED_MESSAGE":
                classic_rest_complete = False

    actor_scopes = (bundle.actor.get("permissions") or {}).get("oauth_scopes") or []
    has_repo_scope = "repo" in actor_scopes
    has_admin_header = False
    perm_header = (bundle.actor.get("permissions") or {}).get("accepted_github_permissions") or ""
    if perm_header and "administration" in str(perm_header).lower():
        has_admin_header = True

    can_claim_classic_absence_for_exact_name = []
    if classic_rest:
        for row in classic_rest.items:
            if row.get("http_class") == "CLASSIC_NOT_PROTECTED_MESSAGE" and (has_repo_scope or has_admin_header):
                can_claim_classic_absence_for_exact_name.append(row.get("branch"))
            elif row.get("http_class") == "OK":
                continue
            else:
                can_claim_classic_absence_for_exact_name.append(None)

    # non-main expected-context conclusion
    unknown_reasons = []
    if not lists_complete:
        unknown_reasons.append("ruleset list pagination or HTTP was not complete")
    if not details_complete:
        unknown_reasons.append("one or more ruleset details were not OK")
    if not bpr_complete:
        unknown_reasons.append("GraphQL branchProtectionRules was not complete")
    if details:
        for item in details.items:
            if item.get("http_class") != "OK":
                unknown_reasons.append(f"ruleset {item.get('id')} detail {item.get('http_class')}")
            elif isinstance(item.get("body"), dict) and "bypass_actors" not in item["body"]:
                # bypass gap is not the same as context-scope unknown
                pass
    inherited_gap = False
    if list_true and list_true.status not in {"OK"}:
        inherited_gap = True
        unknown_reasons.append("includes_parents=true list not OK")
    org_probe = bundle.sources.get("org_or_enterprise_probe")
    enterprise_unknown = True
    if org_probe and org_probe.extra.get("enterprise") != "UNKNOWN_NOT_READ":
        enterprise_unknown = False
    # Unread enterprise overlays stay UNKNOWN in unconfirmed sources. They do
    # not convert a complete repository-source export into "no rules". They also
    # do not block a repository-scoped limited conclusion.

    active_non_main_hits = [
        h for h in non_main_context_hits if h.get("enforcement") in {None, "active"} or h.get("source") == "classic_branchProtectionRule"
    ]
    # ruleset evaluate/disabled hits are recorded separately
    active_only_hits = []
    evaluate_or_disabled_hits = []
    for hit in non_main_context_hits:
        if hit.get("source") == "classic_branchProtectionRule":
            active_only_hits.append(hit)
        elif hit.get("enforcement") == "active":
            active_only_hits.append(hit)
        else:
            evaluate_or_disabled_hits.append(hit)

    if unknown_reasons:
        non_main_conclusion = "UNKNOWN"
        non_main_basis = unknown_reasons
    elif active_only_hits:
        non_main_conclusion = "PRESENT"
        non_main_basis = ["complete pattern analysis found expected context on a non-default-capable pattern"]
    else:
        non_main_conclusion = "NOT_PRESENT_IN_COMPLETE_EXPORT"
        non_main_basis = [
            "Complete paginated ruleset lists, each detail, and complete GraphQL branchProtectionRules "
            "patterns were analyzed. No active ruleset or classic pattern that can match outside the "
            "default branch required the expected context. This is not a claim about unread enterprise overlays."
        ]

    # PR #11 scope conflict
    if non_main_conclusion == "UNKNOWN":
        conflict = "UNKNOWN"
        conflict_reason = (
            "Cannot decide whether the main-only workflow trigger conflicts with non-main required "
            f"context {expected!r} because coverage is incomplete."
        )
    elif non_main_conclusion == "PRESENT":
        conflict = "CONFLICT"
        conflict_reason = (
            "A complete pattern analysis found the expected required context on a pattern that can "
            "apply outside main. Restricting the trusted workflow trigger to main would leave those "
            "non-main refs unable to produce the required check."
        )
    else:
        conflict = "NO_CONFLICT_IN_REPOSITORY_EXPORT"
        conflict_reason = (
            "Within the complete repository ruleset list/details (includes_parents true and false) "
            "and complete GraphQL classic pattern list, the expected context is not required on "
            "non-default-capable active rulesets or classic patterns. Evaluate/disabled hits are listed "
            "separately. Effective-rules endpoint evidence is listed separately and does not replace "
            "classic protection. Enterprise overlays remain UNKNOWN."
        )

    owner_prereqs = []
    if unknown_reasons:
        owner_prereqs.append("Complete readable export of every protection source still UNKNOWN or incomplete.")
    if details:
        for item in details.items:
            body = item.get("body") if isinstance(item.get("body"), dict) else None
            if item.get("http_class") == "OK" and isinstance(body, dict) and "bypass_actors" not in body:
                owner_prereqs.append(
                    f"Ruleset {body.get('id')}: bypass_actors omitted; GitHub withholds this without write access to the ruleset."
                )
    if enterprise_unknown:
        owner_prereqs.append("Enterprise inherited rulesets remain UNKNOWN.")
    if bundle.drift.get("drift_detected"):
        owner_prereqs.append("Identity drifted during collection; do not treat the run as a single snapshot.")
    owner_prereqs.append("This packet is an adoption-prerequisite assessment only. ADOPTION is not performed.")

    confirmed = []
    for row in ruleset_rows:
        if row.get("http_class") == "OK":
            confirmed.append(
                {
                    "kind": "ruleset",
                    "id": row.get("id"),
                    "name": row.get("name"),
                    "enforcement": row.get("enforcement"),
                    "include": row.get("include"),
                    "expected_context_bindings": row.get("expected_context_bindings"),
                }
            )
    if bpr_complete:
        confirmed.append(
            {
                "kind": "classic_branchProtectionRules_patterns",
                "count": len(bpr_rows),
                "patterns": [row.get("pattern") for row in bpr_rows],
            }
        )
    if classic_rest:
        for row in classic_rest.items:
            if row.get("http_class") in {"OK", "CLASSIC_NOT_PROTECTED_MESSAGE"}:
                confirmed.append(
                    {
                        "kind": "classic_rest_exact_name",
                        "branch": row.get("branch"),
                        "http_class": row.get("http_class"),
                    }
                )

    unconfirmed = []
    for gap in bundle.gaps:
        unconfirmed.append(gap)
    if enterprise_unknown:
        unconfirmed.append({"source": "enterprise_inherited_rulesets", "status": "UNKNOWN"})
    if not lists_complete:
        unconfirmed.append({"source": "repository_rulesets_list", "status": "INCOMPLETE_OR_FAILED"})
    if not bpr_complete:
        unconfirmed.append({"source": "branchProtectionRules", "status": (bpr.status if bpr else "MISSING")})

    coverage_status = "PARTIAL"
    if unknown_reasons:
        coverage_status = "PARTIAL"
    elif non_main_conclusion == "NOT_PRESENT_IN_COMPLETE_EXPORT" and details_complete and lists_complete and bpr_complete:
        coverage_status = "COMPLETE_FOR_REPOSITORY_SOURCES_ENTERPRISE_UNKNOWN"
    else:
        coverage_status = "PARTIAL"

    same_context_different_apps = []
    bindings = []
    for row in ruleset_rows:
        for binding in row.get("expected_context_bindings") or []:
            bindings.append(("ruleset", row.get("id"), binding.get("integration_id")))
    for row in bpr_rows:
        for binding in row.get("expected_context_bindings") or []:
            bindings.append(("classic", row.get("pattern"), binding.get("app_database_id")))
    ids_for_context = {item[2] for item in bindings}
    if len(ids_for_context) > 1:
        same_context_different_apps = bindings

    return {
        "expected_context": expected,
        "known_ruleset_id": config.known_ruleset_id,
        "default_branch": default_branch,
        "lists_complete": lists_complete,
        "details_complete": details_complete,
        "bpr_complete": bpr_complete,
        "classic_rest_exact_names_interpretable": classic_rest_complete,
        "rulesets": ruleset_rows,
        "classic_patterns": bpr_rows,
        "effective": effective_context,
        "non_main_expected_context": {
            "conclusion": non_main_conclusion,
            "basis": non_main_basis,
            "active_or_classic_hits": active_only_hits,
            "evaluate_or_disabled_hits": evaluate_or_disabled_hits,
            "method": (
                "Full include/exclude and classic pattern analysis. Not inferred from a sample of branches."
            ),
        },
        "pr11_main_only_trigger": {
            "conflict": conflict,
            "reason": conflict_reason,
            "workflow_change": "PR #11 adds branches: [main] to pull_request_target on trusted-phase2d-freeze.yml",
        },
        "same_context_different_app_bindings": same_context_different_apps,
        "confirmed": confirmed,
        "unconfirmed": unconfirmed,
        "owner_adoption_prerequisites_still_missing": owner_prereqs,
        "coverage_status": coverage_status,
        "has_repo_scope": has_repo_scope,
        "has_admin_permission_header": has_admin_header,
        "classic_not_protected_exact_names": [b for b in can_claim_classic_absence_for_exact_name if b],
        "identity_match_before": bundle.identity_before.get("match"),
        "identity_drift": bundle.drift,
        "historical_collector_input_missing": "59d10c476de54be81b822d1eb592e7f76955c794",
        "this_tool_is_not_that_publication": True,
    }


def render_coverage_md(bundle: CollectionBundle, analysis: dict[str, Any]) -> str:
    expected = analysis["expected_context"]
    non_main = analysis["non_main_expected_context"]
    conflict = analysis["pr11_main_only_trigger"]
    lines = [
        "# Protection coverage (collector v2)",
        "",
        "This file is **derived analysis**. Raw HTTP bodies are in `raw/`. Do not treat this markdown as the raw export.",
        "",
        "This collector is **new and independent**. It is not a restoration of any prior collector, not the same bytes, and does not inherit prior tool review.",
        "",
        "Historical `COLLECTOR_INPUT_MISSING` publication `59d10c476de54be81b822d1eb592e7f76955c794` remains a separate observation.",
        "",
        "```text",
        "ADOPTION=NOT_PERFORMED",
        "NOT_DECLARED=PASS, ACCEPT, MERGE AUTHORIZED, LIVE AUTHORIZED",
        "```",
        "",
        "## Collection window",
        "",
        f"- started_at: `{bundle.started_at}`",
        f"- finished_at: `{bundle.finished_at}`",
        f"- actor_login: `{bundle.actor.get('login')}` (token not recorded)",
        f"- oauth_scopes: `{((bundle.actor.get('permissions') or {}).get('oauth_scopes'))}`",
        f"- identity drift: `{bundle.drift.get('drift_detected')}`",
        f"- default_branch: `{analysis['default_branch']}`",
        f"- expected_context: `{expected}`",
        f"- known_ruleset_id requested: `{config_id(bundle)}`",
        "",
        "## Confirmed rules",
        "",
    ]
    if not analysis["confirmed"]:
        lines.append("No protection source reached a confirmed OK export in this run.")
        lines.append("")
    else:
        for row in analysis["confirmed"]:
            lines.append(f"- `{row}`")
        lines.append("")
    lines.extend(["## Unconfirmed sources or branches", ""])
    if not analysis["unconfirmed"]:
        lines.append("Repository ruleset list/details and classic GraphQL patterns completed. Enterprise inherited rulesets remain UNKNOWN.")
        lines.append("")
    else:
        for row in analysis["unconfirmed"]:
            lines.append(f"- `{row}`")
        lines.append("")
    lines.extend(
        [
            "## non-main required context",
            "",
            f"- conclusion: **{non_main['conclusion']}**",
            f"- method: {non_main['method']}",
            "",
        ]
    )
    for item in non_main["basis"]:
        lines.append(f"- basis: {item}")
    lines.append("")
    if non_main["active_or_classic_hits"]:
        lines.append("Active/classic non-main-capable hits:")
        for hit in non_main["active_or_classic_hits"]:
            lines.append(f"- `{hit}`")
        lines.append("")
    if non_main["evaluate_or_disabled_hits"]:
        lines.append("Evaluate/disabled rulesets that would matter if activated:")
        for hit in non_main["evaluate_or_disabled_hits"]:
            lines.append(f"- `{hit}`")
        lines.append("")
    lines.extend(
        [
            "## PR #11 main-only trigger scope conflict",
            "",
            "PR #11 adds `branches: [main]` to `.github/workflows/trusted-phase2d-freeze.yml`.",
            "That stops the workflow from running for non-main bases. A conflict exists when a",
            f"required check named `{expected}` (any app/integration identity) still applies",
            "outside main.",
            "",
            f"- conflict: **{conflict['conflict']}**",
            f"- reason: {conflict['reason']}",
            "",
            "Effective rules (rulesets, active only) and classic branch protection are listed separately above.",
            "Neither is treated as a complete substitute for the other.",
            "",
            "Open PR identities, including PR #12, are collected only so their bases can be checked for",
            "applicable protection. PR #12 evidence is not PR #11 acceptance evidence.",
            "",
            "## Owner adoption prerequisites still missing",
            "",
        ]
    )
    for item in analysis["owner_adoption_prerequisites_still_missing"]:
        lines.append(f"- {item}")
    lines.extend(
        [
            "",
            "## Interpretation limits",
            "",
            "- HTTP 401/403/404/429, malformed bodies, and incomplete pagination are coverage gaps, not 'no rule'.",
            "- Empty arrays are usable only when the request was OK, pagination completed, and the caller had sufficient permission for that source.",
            "- `GET /repos/.../rules/branches/{branch}` omits evaluate/disabled rulesets and does not export classic protection.",
            "- `bypass_actors` omitted means UNKNOWN bypass, not an empty bypass list.",
            "- Sampling existing branches is not used to conclude that every possible non-main name lacks a requirement.",
            "",
        ]
    )
    return "\n".join(lines) + "\n"


def config_id(bundle: CollectionBundle) -> int:
    return bundle.config.known_ruleset_id
