"""REST Link-header and GraphQL cursor pagination helpers."""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable
from urllib.parse import parse_qs, urlparse

from .constants import REST_PER_PAGE

_LINK_RE = re.compile(r'<([^>]+)>\s*;\s*rel="([^"]+)"')


def parse_link_rels(link_header: str | None) -> dict[str, str]:
    rels: dict[str, str] = {}
    if not link_header:
        return rels
    for match in _LINK_RE.finditer(link_header):
        rels[match.group(2)] = match.group(1)
    return rels


def page_from_url(url: str | None) -> int | None:
    if not url:
        return None
    parsed = urlparse(url)
    values = parse_qs(parsed.query).get("page") or []
    if not values:
        return None
    try:
        return int(values[0])
    except ValueError:
        return None


def next_page_number(link_header: str | None) -> int | None:
    return page_from_url(parse_link_rels(link_header).get("next"))


def merge_unique(items: Iterable[Any], key_fn: Callable[[Any], Any]) -> tuple[list[Any], list[Any]]:
    ordered: list[Any] = []
    seen: set[Any] = set()
    duplicates: list[Any] = []
    for item in items:
        try:
            key = key_fn(item)
        except Exception:
            ordered.append(item)
            continue
        if key in seen:
            duplicates.append(key)
            continue
        seen.add(key)
        ordered.append(item)
    return ordered, duplicates


def rest_pagination_status(
    *,
    pages_fetched: int,
    last_status: int | None,
    last_item_count: int | None,
    next_page: int | None,
    per_page: int = REST_PER_PAGE,
    max_pages: int,
) -> dict[str, Any]:
    complete = (
        last_status == 200
        and next_page is None
        and pages_fetched > 0
        and pages_fetched < max_pages
    )
    truncated = pages_fetched >= max_pages and next_page is not None
    interrupted = last_status not in (None, 200) or (pages_fetched == 0)
    return {
        "complete": bool(complete) and not truncated and not interrupted,
        "pages_fetched": pages_fetched,
        "last_status": last_status,
        "last_item_count": last_item_count,
        "next_page": next_page,
        "per_page": per_page,
        "truncated_by_max_pages": truncated,
        "interrupted": interrupted and not complete,
        "empty_page_is_not_absence": last_item_count == 0,
    }


def graphql_pagination_status(
    *,
    pages_fetched: int,
    last_ok: bool,
    has_next_page: bool,
    max_pages: int,
) -> dict[str, Any]:
    truncated = pages_fetched >= max_pages and has_next_page
    complete = last_ok and pages_fetched > 0 and not has_next_page and not truncated
    return {
        "complete": complete,
        "pages_fetched": pages_fetched,
        "has_next_page": has_next_page,
        "truncated_by_max_pages": truncated,
        "interrupted": not last_ok or pages_fetched == 0,
    }
