"""Write raw evidence, derived analysis, manifests, and checksums."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from .analyze import analyze, render_coverage_md
from .collect import CollectionBundle, SourceResult
from .constants import IDENTITY_DISCLAIMER, TOOL_NAME, VERSION
from .redact import evidence_contains_secret, redact_text
from .transport import HttpExchange


def _json(obj: Any) -> str:
    return json.dumps(obj, indent=2, sort_keys=False, default=_default) + "\n"


def _default(obj: Any):
    if is_dataclass(obj):
        return asdict(obj)
    if isinstance(obj, Path):
        return str(obj)
    return str(obj)


def source_to_dict(source: SourceResult) -> dict[str, Any]:
    return {
        "name": source.name,
        "status": source.status,
        "http_statuses": source.http_statuses,
        "pagination": source.pagination,
        "item_count": len(source.items),
        "duplicates": source.duplicates,
        "notes": source.notes,
        "exchange_ids": source.exchanges,
        "extra": source.extra,
        "items": source.items,
    }


def ledger_from_transport(exchanges: list[HttpExchange]) -> list[dict[str, Any]]:
    rows = []
    for ex in exchanges:
        rows.append(
            {
                "id": ex.id,
                "kind": ex.kind,
                "method": ex.method,
                "endpoint": ex.endpoint,
                "url": ex.url,
                "requested_at": ex.requested_at,
                "duration_ms": ex.duration_ms,
                "status": ex.status,
                "page": ex.page,
                "parse_ok": ex.parse_ok,
                "graphql": ex.graphql,
                "headers": ex.headers,
                "error": ex.error,
                "extra": ex.extra,
                "body_sha256": hashlib.sha256((ex.body or "").encode("utf-8")).hexdigest(),
                "body_bytes": len((ex.body or "").encode("utf-8")),
            }
        )
    return rows


def write_packet(bundle: CollectionBundle, exchanges: list[HttpExchange], *, tests: dict[str, Any] | None = None) -> dict[str, Any]:
    out = Path(bundle.config.out_dir)
    raw_dir = out / "raw"
    derived_dir = out / "derived"
    raw_dir.mkdir(parents=True, exist_ok=True)
    derived_dir.mkdir(parents=True, exist_ok=True)

    for ex in exchanges:
        body_path = raw_dir / f"{ex.id}.body"
        meta_path = raw_dir / f"{ex.id}.meta.json"
        body_path.write_text(ex.body or "", encoding="utf-8")
        meta_path.write_text(
            _json(
                {
                    "id": ex.id,
                    "kind": ex.kind,
                    "method": ex.method,
                    "endpoint": ex.endpoint,
                    "url": ex.url,
                    "requested_at": ex.requested_at,
                    "duration_ms": ex.duration_ms,
                    "status": ex.status,
                    "page": ex.page,
                    "parse_ok": ex.parse_ok,
                    "headers": ex.headers,
                    "extra": ex.extra,
                }
            ),
            encoding="utf-8",
        )

    analysis = analyze(bundle)
    coverage_md = render_coverage_md(bundle, analysis)
    (derived_dir / "analysis.json").write_text(_json(analysis), encoding="utf-8")
    (derived_dir / "identity-before.json").write_text(_json(bundle.identity_before), encoding="utf-8")
    (derived_dir / "identity-after.json").write_text(_json(bundle.identity_after), encoding="utf-8")
    (derived_dir / "drift.json").write_text(_json(bundle.drift), encoding="utf-8")
    (derived_dir / "sources.json").write_text(
        _json({name: source_to_dict(source) for name, source in bundle.sources.items()}),
        encoding="utf-8",
    )
    (out / "coverage.md").write_text(coverage_md, encoding="utf-8")
    (derived_dir / "coverage.md").write_text(coverage_md, encoding="utf-8")

    ledger = {
        "schema": "protection-collector-v2-request-ledger/1",
        "disclaimer": IDENTITY_DISCLAIMER,
        "started_at": bundle.started_at,
        "finished_at": bundle.finished_at,
        "requests": ledger_from_transport(exchanges),
    }
    (out / "request-ledger.json").write_text(_json(ledger), encoding="utf-8")

    live_status = classify_live(bundle, analysis)
    owner_required = live_status in {"PARTIAL", "AUTH_FAILED", "FORBIDDEN", "NOT_RUN"} or analysis["coverage_status"] != "COMPLETE_FOR_REPOSITORY_SOURCES_ENTERPRISE_UNKNOWN"
    # OWNER_STEP is for missing permissions, not for remaining enterprise UNKNOWN after a successful owner-scoped read.
    permission_blocked = any(
        source.status in {"AUTH_FAILED", "FORBIDDEN"} or any(code in {401, 403} for code in source.http_statuses)
        for source in bundle.sources.values()
        if source.name != "org_or_enterprise_probe"
    )
    # 404 on org probe for a user owner is expected.
    if bundle.actor.get("http_class") in {"AUTH_FAILED", "FORBIDDEN"}:
        permission_blocked = True

    status = {
        "schema": "protection-collector-v2-status/1",
        "TOOL_IMPLEMENTATION": "COMPLETE",
        "TOOL_TESTS": (tests or {}).get("result", "NOT_RECORDED_IN_PACKET"),
        "LIVE_COLLECTION": live_status,
        "PROTECTION_COVERAGE": analysis["coverage_status"],
        "OWNER_ACTION_REQUIRED": bool(permission_blocked),
        "ADOPTION": "NOT_PERFORMED",
        "NOT_DECLARED": ["PASS", "ACCEPT", "MERGE AUTHORIZED", "LIVE AUTHORIZED"],
        "started_at": bundle.started_at,
        "finished_at": bundle.finished_at,
        "identity_match_before": bundle.identity_before.get("match"),
        "identity_drift": bundle.drift,
        "gaps": bundle.gaps,
        "historical_COLLECTOR_INPUT_MISSING": "59d10c476de54be81b822d1eb592e7f76955c794",
        "disclaimer": IDENTITY_DISCLAIMER,
    }
    (out / "status.json").write_text(_json(status), encoding="utf-8")

    manifest = {
        "schema": "protection-collector-v2-tool-manifest/1",
        "tool_name": TOOL_NAME,
        "version": VERSION,
        "disclaimer": IDENTITY_DISCLAIMER,
        "source_commit": bundle.environment.get("git_head"),
        "source_tree": bundle.environment.get("git_tree"),
        "git_dirty": bundle.environment.get("git_dirty"),
        "source_files_sha256": bundle.environment.get("source_files_sha256"),
        "environment": bundle.environment.get("versions"),
        "actor": {
            "login": bundle.actor.get("login"),
            "id": bundle.actor.get("id"),
            "type": bundle.actor.get("type"),
            "permissions": bundle.actor.get("permissions"),
            "token_recorded": False,
        },
        "gh_auth_status": bundle.environment.get("gh_auth_status"),
        "documentation_basis": bundle.documentation_basis,
        "collection_started_at": bundle.started_at,
        "collection_finished_at": bundle.finished_at,
        "out_dir": str(out),
    }
    (out / "tool-manifest.json").write_text(_json(manifest), encoding="utf-8")

    if permission_blocked:
        (out / "OWNER_STEP.md").write_text(render_owner_step(bundle, analysis), encoding="utf-8")

    secret_hits = []
    for path in out.rglob("*"):
        if not path.is_file():
            continue
        if path.name == "SHA256SUMS":
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if evidence_contains_secret(text):
            secret_hits.append(path.as_posix())
    if secret_hits:
        raise RuntimeError(f"secret-like token leaked into evidence files: {secret_hits}")

    write_sha256sums(out)
    return {"status": status, "analysis": analysis, "out_dir": str(out), "secret_hits": secret_hits}


def classify_live(bundle: CollectionBundle, analysis: dict[str, Any]) -> str:
    if bundle.actor.get("http_class") == "AUTH_FAILED":
        return "AUTH_FAILED"
    classes = []
    for source in bundle.sources.values():
        classes.append(source.status)
    if any(status in {"AUTH_FAILED"} for status in classes):
        return "AUTH_FAILED"
    if any(status in {"FORBIDDEN"} for status in classes):
        return "PARTIAL"
    if analysis["lists_complete"] and analysis["details_complete"] and analysis["bpr_complete"]:
        return "COMPLETE"
    return "PARTIAL"


def render_owner_step(bundle: CollectionBundle, analysis: dict[str, Any]) -> str:
    commit = bundle.environment.get("git_head") or "<TOOL_COMMIT_SHA>"
    out = bundle.config.out_dir.as_posix()
    return f"""# OWNER_STEP — protection collector v2

This is not a request to paste a token into chat.

The collector uses the existing `gh` keyring / environment credential. Do not put a token on the command line.

## Missing permission (minimum)

Fine-grained (if that is what you use):

- Repository Metadata: read (GET rulesets, GET rulesets/{{id}}, GET rules/branches/{{branch}})
- Repository Administration: read (GET branches/{{branch}}/protection and a complete classic export)
- Contents: not required for this collector
- Organization Administration: not applicable for a User-owned repository; enterprise overlays remain UNKNOWN without an enterprise read

Classic PAT / `gh` OAuth observed scopes are recorded in `tool-manifest.json` without the token.

GitHub documents that `bypass_actors` is omitted unless the caller has write access to the ruleset. That omission is a coverage gap, not empty bypass.

Do not grant withdrawal, workflow write, or settings write for this task. Do not modify rulesets or branch protection.

## Exact command after the tool commit exists

```bash
git fetch origin {commit}
git switch --detach {commit}
python3 tools/review/protection-collector-v2/collect.py \\
  --repo {bundle.config.owner}/{bundle.config.repo} \\
  --review-pr {bundle.config.review_pr} \\
  --expected-main {bundle.config.expected_main} \\
  --review-head {bundle.config.review_head} \\
  --review-tree {bundle.config.review_tree} \\
  --known-ruleset-id {bundle.config.known_ruleset_id} \\
  --expected-context {bundle.config.expected_context} \\
  --frozen-ref experiment/v0.1-phase2 \\
  --frozen-ref experiment/v0.1-phase2e-halt-ack \\
  --frozen-ref governance/phase2e-trusted-gate \\
  --out {out}
```

If `gh auth status` reports an invalid keyring token, run `gh auth refresh -h github.com` locally. Do not paste the token here.
"""


def write_sha256sums(out: Path) -> None:
    lines = []
    for path in sorted(p for p in out.rglob("*") if p.is_file()):
        if path.name == "SHA256SUMS":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        relative = path.relative_to(out).as_posix()
        lines.append(f"{digest}  {relative}")
    (out / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def scan_for_secrets(root: Path) -> list[str]:
    hits = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if evidence_contains_secret(text):
            hits.append(path.as_posix())
    return hits
