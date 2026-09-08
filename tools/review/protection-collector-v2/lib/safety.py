"""Reject REST writes and GraphQL mutations."""

from __future__ import annotations

import re

class SafetyError(ValueError):
    """Raised when a disallowed GitHub operation is requested."""


_GQL_COMMENT_RE = re.compile(r"#[^\n]*")
_GQL_STRING_RE = re.compile(r'"""[\s\S]*?"""|"([^"\\]|\\.)*"')


def assert_rest_method(method: str) -> None:
    normalized = (method or "").strip().upper()
    if normalized != "GET":
        raise SafetyError(
            f"REST method {normalized!r} is forbidden. This collector allows REST GET only."
        )


def _strip_graphql_literals(document: str) -> str:
    without_block = re.sub(r'"""[\s\S]*?"""', '""', document)
    without_strings = _GQL_STRING_RE.sub('""', without_block)
    return _GQL_COMMENT_RE.sub("", without_strings)


def graphql_document_is_query(document: str) -> bool:
    if not document or not str(document).strip():
        return False
    stripped = _strip_graphql_literals(document)
    tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", stripped)
    if not tokens:
        return False
    if "mutation" in tokens:
        return False
    if "subscription" in tokens:
        return False
    # Anonymous queries start with '{'. After stripping strings/comments, a
    # leading brace is an implicit query.
    compact = stripped.lstrip()
    if compact.startswith("{"):
        return True
    return tokens[0] == "query"


def assert_graphql_query(document: str) -> None:
    if not graphql_document_is_query(document):
        raise SafetyError(
            "GraphQL document is not an allowed query. Mutations and subscriptions are forbidden."
        )
