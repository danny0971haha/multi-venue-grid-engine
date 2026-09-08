"""Remove credentials from headers, JSON, and text before any evidence write."""

from __future__ import annotations

import json
import re
from typing import Any

from .constants import DROP_RESPONSE_HEADER_NAMES, SAFE_RESPONSE_HEADER_NAMES, TOKEN_PREFIXES

_TOKEN_RE = re.compile(
    r"(?:gho_|ghp_|github_pat_|ghu_|ghr_|Bearer\s+)[A-Za-z0-9_\-.=*]+",
    re.IGNORECASE,
)
_SENSITIVE_KEY_RE = re.compile(
    r"(token|authorization|password|secret|client_secret|access_token|refresh_token|private_key)",
    re.IGNORECASE,
)


def looks_like_token(value: str) -> bool:
    if not value:
        return False
    stripped = value.strip()
    return any(stripped.startswith(prefix) for prefix in TOKEN_PREFIXES) or bool(
        _TOKEN_RE.search(stripped)
    )


def redact_text(text: str | None) -> str:
    if text is None:
        return ""
    return _TOKEN_RE.sub("[REDACTED_TOKEN]", str(text))


def redact_headers(headers: dict[str, str] | None) -> dict[str, str]:
    kept: dict[str, str] = {}
    for raw_name, raw_value in (headers or {}).items():
        name = str(raw_name).strip()
        lower = name.lower()
        if lower in DROP_RESPONSE_HEADER_NAMES:
            continue
        if lower not in SAFE_RESPONSE_HEADER_NAMES:
            # Unknown header: keep the name, drop a value that looks like a secret.
            value = "" if looks_like_token(str(raw_value)) else redact_text(str(raw_value))
            if lower.startswith("x-") and "auth" in lower:
                continue
            kept[name] = value
            continue
        kept[name] = redact_text(str(raw_value))
    return kept


def _redact_json_value(value: Any, key: str | None = None) -> Any:
    if key and _SENSITIVE_KEY_RE.search(key):
        return "[REDACTED]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [_redact_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _redact_json_value(v, str(k)) for k, v in value.items()}
    return value


def redact_json_value(value: Any) -> Any:
    return _redact_json_value(value)


def maybe_parse_and_redact_body(body: str) -> tuple[Any | None, str]:
    """Return (parsed_json_or_None, redacted_raw_text)."""
    redacted_text = redact_text(body or "")
    try:
        parsed = json.loads(body) if body else None
    except (TypeError, json.JSONDecodeError):
        return None, redacted_text
    return redact_json_value(parsed), redacted_text


def evidence_contains_secret(text: str) -> bool:
    """True only for unmasked token material. Masked gho_**** values are not secrets."""
    if not text:
        return False
    for match in _TOKEN_RE.finditer(text):
        token = match.group(0)
        payload = re.sub(
            r"^(?:gho_|ghp_|github_pat_|ghu_|ghr_|Bearer\s+)",
            "",
            token,
            flags=re.IGNORECASE,
        )
        if re.fullmatch(r"\*+", payload or ""):
            continue
        if payload:
            return True
    return False
