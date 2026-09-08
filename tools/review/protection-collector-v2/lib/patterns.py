"""GitHub ruleset and classic branch-protection pattern matching."""

from __future__ import annotations

import re
from typing import Any

_CHARCLASS_RE = re.compile(r"\[(!)?([^\]]+)\]")


def github_fnmatch(name: str, pattern: str) -> bool:
    """Approximate Ruby File.fnmatch with FNM_PATHNAME.

    GitHub documents that * does not match '/' and ** crosses directories.
    """
    if name is None or pattern is None:
        return False
    regex = ["^"]
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            regex.append(".*")
            i += 2
            continue
        ch = pattern[i]
        if ch == "*":
            regex.append("[^/]*")
        elif ch == "?":
            regex.append("[^/]")
        elif ch == "[":
            match = _CHARCLASS_RE.match(pattern, i)
            if not match:
                regex.append(re.escape(ch))
            else:
                negate, body = match.group(1), match.group(2)
                inner = re.escape(body)
                regex.append(f"[^{inner}]" if negate else f"[{inner}]")
                i = match.end()
                continue
        else:
            regex.append(re.escape(ch))
        i += 1
    regex.append("$")
    try:
        return re.match("".join(regex), name, re.DOTALL) is not None
    except re.error:
        return False


def ruleset_pattern_matches_ref(pattern: str, ref: str, default_branch: str) -> bool | None:
    if not pattern:
        return None
    if pattern == "~ALL":
        return True
    if pattern == "~DEFAULT_BRANCH":
        return ref == f"refs/heads/{default_branch}"
    if any(ch in pattern for ch in "*?[") or pattern.startswith("~"):
        if pattern.startswith("~") and pattern not in {"~ALL", "~DEFAULT_BRANCH"}:
            return None
        return github_fnmatch(ref, pattern)
    return ref == pattern


def classic_pattern_matches_branch(pattern: str, branch: str) -> bool | None:
    if not pattern:
        return None
    # GitHub documents classic pattern '*' as matching all branches.
    if pattern == "*":
        return True
    if any(ch in pattern for ch in "*?["):
        return github_fnmatch(branch, pattern)
    return branch == pattern


def ref_for_branch(branch: str) -> str:
    if branch.startswith("refs/"):
        return branch
    return f"refs/heads/{branch}"


def pattern_scope(pattern: str, *, kind: str, default_branch: str) -> str:
    """Classify whether a pattern can apply outside the default branch.

    Returns only_default | can_match_non_default | unknown.
    """
    if not pattern:
        return "unknown"
    if kind == "ruleset":
        if pattern in {"~ALL"}:
            return "can_match_non_default"
        if pattern == "~DEFAULT_BRANCH":
            return "only_default"
        if pattern == f"refs/heads/{default_branch}":
            return "only_default"
        if pattern.startswith("~"):
            return "unknown"
        if any(ch in pattern for ch in "*?["):
            return "unknown"
        return "can_match_non_default"
    if kind == "classic":
        if pattern == "*":
            return "can_match_non_default"
        if pattern == default_branch:
            return "only_default"
        if any(ch in pattern for ch in "*?["):
            # A non-main literal prefix establishes a possible non-main scope.
            # Otherwise no finite set of example branches proves main-only.
            prefix = re.split(r"[*?\[]", pattern, maxsplit=1)[0]
            return "can_match_non_default" if prefix and not default_branch.startswith(prefix) else "unknown"
        return "can_match_non_default"
    return "unknown"


def ruleset_applies_to_ref(conditions: dict[str, Any] | None, ref: str, default_branch: str) -> bool | None:
    if not conditions:
        return None
    ref_name = conditions.get("ref_name") if isinstance(conditions, dict) else None
    if not isinstance(ref_name, dict):
        return None
    includes = ref_name.get("include") or []
    excludes = ref_name.get("exclude") or []
    if not includes:
        return False
    include_hits = [ruleset_pattern_matches_ref(p, ref, default_branch) for p in includes]
    if any(h is None for h in include_hits):
        return None
    if not any(include_hits):
        return False
    exclude_hits = [ruleset_pattern_matches_ref(p, ref, default_branch) for p in excludes]
    if any(h is None for h in exclude_hits):
        return None
    if any(exclude_hits):
        return False
    return True


def ruleset_non_default_possible(conditions: dict[str, Any] | None, default_branch: str) -> str:
    if not conditions or not isinstance(conditions, dict):
        return "unknown"
    ref_name = conditions.get("ref_name")
    if not isinstance(ref_name, dict):
        return "unknown"
    includes = ref_name.get("include") or []
    if not includes:
        return "no_include"
    scopes = [pattern_scope(p, kind="ruleset", default_branch=default_branch) for p in includes]
    if "unknown" in scopes:
        return "unknown"
    if all(s == "only_default" for s in scopes):
        return "only_default"
    return "can_match_non_default"
