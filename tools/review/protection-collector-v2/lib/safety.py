"""Reject REST writes and GraphQL mutations."""

from __future__ import annotations

import re

class SafetyError(ValueError):
    """Raised when a disallowed GitHub operation is requested."""



def assert_rest_method(method: str) -> None:
    normalized = (method or "").strip().upper()
    if normalized != "GET":
        raise SafetyError(
            f"REST method {normalized!r} is forbidden. This collector allows REST GET only."
        )


def _strip_graphql_literals(document: str) -> str:
    # Lex comments before strings. Quotes inside a comment must not hide a real operation.
    out = []
    i = 0
    while i < len(document):
        if document[i] == "#":
            end = document.find("\n", i)
            i = len(document) if end == -1 else end
        elif document.startswith('"""', i):
            i += 3
            while i < len(document) and not document.startswith('"""', i):
                i += 4 if document.startswith('\\"""', i) else 1
            if i == len(document):
                return ""
            i += 3
            out.append(" ")
        elif document[i] == '"':
            i += 1
            while i < len(document) and document[i] != '"':
                i += 2 if document[i] == "\\" else 1
            if i >= len(document):
                return ""
            i += 1
            out.append(" ")
        else:
            out.append(document[i])
            i += 1
    return "".join(out)


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
