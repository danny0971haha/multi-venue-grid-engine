"""Derived analysis. Never treats HTTP errors or incomplete pages as 'no rules'."""

from __future__ import annotations

from typing import Any

from .collect import CollectionBundle, SourceResult
from .patterns import classic_pattern_matches_branch, pattern_scope, ref_for_branch, ruleset_applies_to_ref, ruleset_non_default_possible


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
        params = rule.get("parameters") if isinstance(rule.get("parameters"), dict) else {}
        for check in (params.get("required_status_checks") if isinstance(params.get("required_status_checks"), list) else []):
            if not isinstance(check, dict) or not isinstance(check.get("context"), str) or (check.get("integration_id") is not None and type(check.get("integration_id")) is not int):
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
            if not isinstance(app, dict) or (app.get("databaseId") is not None and type(app.get("databaseId")) is not int):
                continue
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
    from .validation import obj, bpr_errors, ruleset_errors
    config = bundle.config
    expected = config.expected_context
    default = bundle.identity_before.get("default_branch") or "main"
    sources = bundle.sources
    empty = SourceResult("missing", [], "MISSING", [])
    details = sources.get("ruleset_details", empty)
    bpr = sources.get("branchProtectionRules", empty)
    classic = sources.get("classic_branch_protection_rest", empty)
    effective = sources.get("effective_ruleset_rules", empty)
    lists_complete = all(sources.get(n, empty).status == "OK" and sources[n].pagination.get("complete") is True
                         for n in ("rulesets_includes_parents_true", "rulesets_includes_parents_false"))
    details_complete = details.status == "OK" and all(i.get("complete") is True for i in details.items)
    bpr_complete = bpr.status == "OK" and bpr.pagination.get("complete") is True
    repo_admin = all(i.get("repository_http_class") == "OK" and
                     i.get("repository_full_name") == f"{config.owner}/{config.repo}" and
                     obj(i.get("repository_permissions")).get("admin") is True
                     for i in (bundle.identity_before, bundle.identity_after))
    permission_observed = repo_admin and bpr.extra.get("viewer_permission") == "ADMIN" and bundle.actor.get("http_class") == "OK"
    identity_verified = bundle.drift.get("identity_verified") is True
    exact_absent = [i["branch"] for i in classic.items
                    if i.get("http_class") == "CLASSIC_NOT_PROTECTED_MESSAGE" and
                    permission_observed and bpr_complete and identity_verified]
    classic_complete = bool(classic.items) and all(i.get("http_class") == "OK" or i.get("branch") in exact_absent for i in classic.items)
    effective_complete = bool(effective.items) and all(i.get("http_class") == "OK" and obj(i.get("pagination")).get("complete") is True for i in effective.items)
    product = sources.get("org_or_enterprise_probe", empty)
    product_na = (product.status == "NOT_APPLICABLE" and identity_verified)
    unknown, confirmed, rulesets, patterns, active_hits, inactive_hits = [], [], [], [], [], []
    for ok, reason in ((lists_complete, "ruleset list incomplete"), (details_complete, "ruleset detail incomplete"),
                       (bpr_complete, "classic pattern/allowance export incomplete"),
                       (classic_complete, "exact-name classic sources uninterpretable"),
                       (effective_complete, "effective rules export incomplete"),
                       (permission_observed, "caller repository administration not established by repository and GraphQL observations"),
                       (identity_verified, "expected identity mismatch, missing observation or before/after drift"),
                       (product_na, "org/enterprise coverage or product non-applicability not established")):
        if not ok:
            unknown.append(reason)
    for item in details.items:
        body = obj(item.get("body"))
        checks = _required_checks_from_ruleset(body) if isinstance(body.get("rules"), list) else []
        bindings = [c for c in checks if c.get("context") == expected]
        errors = ruleset_errors(body, item.get("id"))
        ref = obj(obj(body.get("conditions")).get("ref_name"))
        conditions_valid = isinstance(ref.get("include"), list) and isinstance(ref.get("exclude"), list) and all(isinstance(p, str) for p in ref['include'] + ref['exclude'])
        scope = ruleset_non_default_possible(body.get("conditions"), default) if conditions_valid else "unknown"
        applies = ruleset_applies_to_ref(body.get("conditions"), f"refs/heads/{default}", default) if conditions_valid else None
        row = {"id": item.get("id"), "name": body.get("name"), "target": body.get("target"),
               "enforcement": body.get("enforcement"), "source_type": body.get("source_type"), "source": body.get("source"),
               "include": ref.get("include"), "exclude": ref.get("exclude"), "required_checks": checks,
               "expected_context_bindings": bindings, "non_default_scope": scope, "applies_to_default": applies,
               "bypass_actors_present": isinstance(body.get("bypass_actors"), list),
               "bypass_actors": body.get("bypass_actors"), "http_class": item.get("http_class"),
               "complete": item.get("complete") is True, "shape_errors": errors}
        rulesets.append(row)
        if item.get("http_class") == "OK" and body.get("id") == item.get("id"):
            confirmed.append({"kind": "observed_ruleset", "id": item['id'], "complete": row['complete'],
                              "enforcement": row['enforcement'], "include": row['include'], "expected_context_bindings": bindings})
        if bindings and body.get("target") == "branch":
            if scope == "unknown":
                unknown.append(f"ruleset {item['id']} branch scope unknown")
            elif scope == "can_match_non_default":
                hit = {"source": "ruleset", "id": item['id'], "enforcement": row['enforcement'], "bindings": bindings}
                if body.get("enforcement") == "active":
                    active_hits.append(hit)
                elif body.get("enforcement") in ("evaluate", "disabled"):
                    inactive_hits.append(hit)
    for node in bpr.items:
        if not isinstance(node, dict):
            continue
        errors = bpr_errors(node)
        checks = _classic_checks(node) if isinstance(node.get("requiredStatusChecks"), list) else []
        bindings = [c for c in checks if c.get("context") == expected]
        scope = pattern_scope(node.get("pattern"), kind="classic", default_branch=default) if isinstance(node.get("pattern"), str) else "unknown"
        row = {"id": node.get("id"), "pattern": node.get("pattern"), "scope": scope,
               "required_checks": checks, "expected_context_bindings": bindings,
               "requires_status_checks": node.get("requiresStatusChecks"), "complete": not errors,
               "shape_errors": errors, "allowances_truncated": any("Allowances" in e for e in errors)}
        patterns.append(row)
        if node.get("id") and node.get("pattern"):
            confirmed.append({"kind": "observed_classic_pattern", **row})
        if bindings and node.get("requiresStatusChecks") is True:
            if scope == "unknown":
                unknown.append("classic pattern scope unknown")
            elif scope == "can_match_non_default":
                active_hits.append({"source": "classic_branchProtectionRule", "pattern": node['pattern'], "bindings": bindings})
    effective_rows = []
    for item in effective.items:
        hits = _required_checks_from_ruleset({"rules": item.get("observed_rules") or []})
        hits = [c for c in hits if c.get("context") == expected]
        complete = item.get("http_class") == "OK" and obj(item.get("pagination")).get("complete") is True
        effective_rows.append({"branch": item.get("branch"), "http_class": item.get("http_class"),
                               "pagination": item.get("pagination"), "expected_context_hits": hits,
                               "expected_context": "PRESENT" if hits else ("NOT_PRESENT_IN_COMPLETE_EXPORT" if complete and permission_observed and identity_verified else "UNKNOWN")})
    # Presence observations survive gaps, but completeness/adoption never follows from them.
    if active_hits:
        conclusion, conflict = "PRESENT", "CONFLICT"
        basis = ["Observed active/classic expected-context requirement on a non-main-capable scope."]
    elif unknown:
        conclusion, conflict, basis = "UNKNOWN", "UNKNOWN", unknown[:]
    else:
        conclusion, conflict = "NOT_PRESENT_IN_COMPLETE_EXPORT", "NO_CONFLICT_IN_COMPLETE_EXPORT"
        basis = ["Complete applicable sources for verified identities contained no non-main expected-context requirement."]
    unconfirmed = list(bundle.gaps) + [{"source": "coverage", "status": "UNKNOWN", "reason": r} for r in unknown]
    prereqs = ["Resolve: " + r for r in unknown]
    prereqs.extend(["Independent review of PR #11 exact head/base, trusted governance adoption order and context/app bindings is still required.",
                    "Sequential observations are not an atomic settings snapshot; revalidate at adoption.",
                    "ADOPTION is not performed. This tool has no inherited reviewer verdict."])
    bindings = [("ruleset", r['id'], c.get('integration_id')) for r in rulesets for c in r['expected_context_bindings']]
    bindings += [("classic", r['id'], c.get('app_database_id')) for r in patterns for c in r['expected_context_bindings']]
    return {"expected_context": expected, "known_ruleset_id": config.known_ruleset_id, "default_branch": default,
        "lists_complete": lists_complete, "details_complete": details_complete, "bpr_complete": bpr_complete,
        "classic_rest_exact_names_interpretable": classic_complete, "effective_complete": effective_complete,
        "rulesets": rulesets, "classic_patterns": patterns, "effective": effective_rows,
        "non_main_expected_context": {"conclusion": conclusion, "basis": basis, "active_or_classic_hits": active_hits,
            "evaluate_or_disabled_hits": inactive_hits, "method": "Full include/exclude and classic pattern analysis; conservative for complex patterns. Not inferred from a sample of branches."},
        "pr11_main_only_trigger": {"conflict": conflict, "reason": basis[0]},
        "same_context_different_app_bindings": bindings if len({b[2] for b in bindings}) > 1 else [],
        "confirmed": confirmed, "unconfirmed": unconfirmed, "owner_adoption_prerequisites_still_missing": prereqs,
        "coverage_status": "PARTIAL" if unknown else "COMPLETE_FOR_APPLICABLE_SOURCES",
        "caller_repository_admin_observed": permission_observed,
        "permission_basis": {"repository_admin_before_and_after": repo_admin,
            "graphql_viewer_permission": bpr.extra.get("viewer_permission"),
            "accepted_headers_are_endpoint_requirements_only": True, "oauth_scopes_alone_are_not_authorization": True},
        "product_applicability": product.extra, "classic_not_protected_exact_names": exact_absent,
        "identity_match_before": bundle.identity_before.get("match"), "identity_match_after": bundle.identity_after.get("match"),
        "identity_drift": bundle.drift, "historical_collector_input_missing": "59d10c476de54be81b822d1eb592e7f76955c794",
        "this_tool_is_not_that_publication": True}


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
        lines.append("No remaining source gap in this sequential collection; product non-applicability evidence is recorded separately.")
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
