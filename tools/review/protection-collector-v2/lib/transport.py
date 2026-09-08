"""Read-only GitHub transport. REST GET and GraphQL query only. No tokens in argv."""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.parse import urlsplit, urlunsplit

from .constants import ACCEPT, GITHUB_API_VERSION
from .redact import redact_headers, redact_text
from .safety import SafetyError, assert_graphql_query, assert_rest_method

DEFAULT_TIMEOUT_SEC = 60


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_gh_include(blob: str) -> tuple[int, dict[str, str], str]:
    text = blob.replace("\r\n", "\n")
    # gh may prefix warnings. Find the HTTP status line.
    lines = text.split("\n")
    start = 0
    status = 0
    for i, line in enumerate(lines):
        if line.startswith("HTTP/"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                status = int(parts[1])
                start = i + 1
                break
    if status == 0:
        return 0, {}, text
    headers: dict[str, str] = {}
    body_start = start
    for i in range(start, len(lines)):
        if lines[i] == "":
            body_start = i + 1
            break
        if ":" in lines[i]:
            name, value = lines[i].split(":", 1)
            headers[name.strip()] = value.strip()
        body_start = i + 1
    body = "\n".join(lines[body_start:])
    return status, headers, body


def sanitize_url(url: str) -> str:
    split = urlsplit(url)
    if split.username or split.password:
        host = split.hostname or ""
        if split.port:
            host = f"{host}:{split.port}"
        split = split._replace(netloc=host)
    return redact_text(urlunsplit(split))


@dataclass
class HttpExchange:
    id: str
    kind: str
    method: str
    endpoint: str
    url: str
    requested_at: str
    duration_ms: int
    status: int
    headers: dict[str, str]
    body: str
    parsed: Any | None
    parse_ok: bool
    page: int | None = None
    graphql: bool = False
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class Transport:
    def rest_get(self, path: str, params: dict[str, Any] | None = None) -> HttpExchange:
        raise NotImplementedError

    def graphql_query(self, query: str, variables: dict[str, Any] | None = None) -> HttpExchange:
        raise NotImplementedError


class GhTransport(Transport):
    def __init__(self, *, timeout_sec: int = DEFAULT_TIMEOUT_SEC, gh_bin: str = "gh") -> None:
        self.timeout_sec = timeout_sec
        self.gh_bin = gh_bin
        self.calls: list[HttpExchange] = []
        self._seq = 0

    def _next_id(self) -> str:
        self._seq += 1
        return f"{self._seq:04d}"

    def _run_gh(self, args: list[str], *, stdin: str | None = None) -> tuple[int, str, str]:
        env = os.environ.copy()
        env.pop("GH_DEBUG", None)
        env.pop("GH_VERBOSE", None)
        # Never add a token flag. Existing gh keyring / GH_TOKEN in the parent
        # environment is the only credential source.
        try:
            completed = subprocess.run(
                [self.gh_bin, *args],
                input=stdin,
                text=True,
                capture_output=True,
                timeout=self.timeout_sec,
                check=False,
                env=env,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return 1, "", type(exc).__name__
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        return completed.returncode, stdout, stderr

    def rest_get(self, path: str, params: dict[str, Any] | None = None) -> HttpExchange:
        assert_rest_method("GET")
        query = urlencode(
            {k: v if not isinstance(v, bool) else ("true" if v else "false") for k, v in (params or {}).items()},
            doseq=True,
        )
        endpoint = path if not query else f"{path}?{query}"
        args = [
            "api",
            "--method",
            "GET",
            "--include",
            "-H",
            f"Accept: {ACCEPT}",
            "-H",
            f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
            endpoint,
        ]
        started = time.monotonic()
        requested_at = utc_now()
        code, stdout, stderr = self._run_gh(args)
        duration_ms = int((time.monotonic() - started) * 1000)
        status, headers, body = _parse_gh_include(stdout)
        if status == 0:
            # gh sometimes prints JSON errors without --include framing.
            body = stdout or stderr
            try:
                parsed_err = json.loads(stdout)
                status = int(parsed_err.get("status") or 0) if isinstance(parsed_err, dict) else 0
            except (TypeError, json.JSONDecodeError, ValueError):
                status = 0
            if status == 0:
                status = 599 if code != 0 else 0
        parsed = None
        parse_ok = False
        try:
            parsed = json.loads(body) if body else None
            parse_ok = True
        except (TypeError, json.JSONDecodeError):
            parse_ok = False
        page = None
        if params and "page" in params:
            try:
                page = int(params["page"])
            except (TypeError, ValueError):
                page = None
        exchange = HttpExchange(
            id=self._next_id(),
            kind="rest",
            method="GET",
            endpoint=endpoint,
            url=sanitize_url(f"https://api.github.com/{endpoint.lstrip('/')}"),
            requested_at=requested_at,
            duration_ms=duration_ms,
            status=status,
            headers=redact_headers(headers),
            body=redact_text(body),
            parsed=parsed,
            parse_ok=parse_ok,
            page=page,
            extra={"gh_exit": code, "stderr_redacted": redact_text(stderr)[:4000]},
        )
        self.calls.append(exchange)
        return exchange

    def graphql_query(self, query: str, variables: dict[str, Any] | None = None) -> HttpExchange:
        assert_graphql_query(query)
        payload = {"query": query, "variables": variables or {}}
        args = [
            "api",
            "graphql",
            "--method",
            "POST",
            "--include",
            "-H",
            f"Accept: {ACCEPT}",
            "-H",
            f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
            "--input",
            "-",
        ]
        started = time.monotonic()
        requested_at = utc_now()
        code, stdout, stderr = self._run_gh(args, stdin=json.dumps(payload))
        duration_ms = int((time.monotonic() - started) * 1000)
        status, headers, body = _parse_gh_include(stdout)
        if status == 0:
            body = stdout or stderr
            status = 599 if code != 0 else 200
        parsed = None
        parse_ok = False
        try:
            parsed = json.loads(body) if body else None
            parse_ok = True
        except (TypeError, json.JSONDecodeError):
            parse_ok = False
        exchange = HttpExchange(
            id=self._next_id(),
            kind="graphql",
            method="POST",
            endpoint="graphql",
            url="https://api.github.com/graphql",
            requested_at=requested_at,
            duration_ms=duration_ms,
            status=status,
            headers=redact_headers(headers),
            body=redact_text(body),
            parsed=parsed,
            parse_ok=parse_ok,
            graphql=True,
            extra={"gh_exit": code, "stderr_redacted": redact_text(stderr)[:4000],
                   "query": query, "variables": variables or {}},
        )
        self.calls.append(exchange)
        return exchange


class FakeTransport(Transport):
    """Scripted transport for offline tests. Still enforces the write/mutation ban."""

    def __init__(self) -> None:
        self.rest_scripts: list[tuple[Any, HttpExchange | dict[str, Any]]] = []
        self.graphql_scripts: list[tuple[Any, HttpExchange | dict[str, Any]]] = []
        self.calls: list[HttpExchange] = []
        self._seq = 0

    def _next_id(self) -> str:
        self._seq += 1
        return f"{self._seq:04d}"

    def add_rest(self, matcher, response: HttpExchange | dict[str, Any]) -> None:
        self.rest_scripts.append((matcher, response))

    def add_graphql(self, matcher, response: HttpExchange | dict[str, Any]) -> None:
        self.graphql_scripts.append((matcher, response))

    def _materialize(self, spec: HttpExchange | dict[str, Any], *, kind: str, method: str, endpoint: str) -> HttpExchange:
        if isinstance(spec, HttpExchange):
            spec.id = spec.id or self._next_id()
            self.calls.append(spec)
            return spec
        body = spec.get("body", "")
        if not isinstance(body, str):
            body = json.dumps(spec.get("body"))
        parsed = spec.get("parsed")
        parse_ok = spec.get("parse_ok")
        if parsed is None and body:
            try:
                parsed = json.loads(body)
                parse_ok = True
            except json.JSONDecodeError:
                parse_ok = False
        elif parsed is not None:
            parse_ok = True if parse_ok is None else parse_ok
        exchange = HttpExchange(
            id=self._next_id(),
            kind=kind,
            method=method,
            endpoint=endpoint,
            url=spec.get("url") or f"https://api.github.com/{endpoint}",
            requested_at=spec.get("requested_at") or utc_now(),
            duration_ms=int(spec.get("duration_ms") or 0),
            status=int(spec["status"]),
            headers=redact_headers(spec.get("headers") or {}),
            body=redact_text(body),
            parsed=parsed,
            parse_ok=bool(parse_ok),
            page=spec.get("page"),
            graphql=kind == "graphql",
            extra=spec.get("extra") or {},
        )
        self.calls.append(exchange)
        return exchange

    def rest_get(self, path: str, params: dict[str, Any] | None = None) -> HttpExchange:
        assert_rest_method("GET")
        query = urlencode(
            {k: v if not isinstance(v, bool) else ("true" if v else "false") for k, v in (params or {}).items()},
            doseq=True,
        )
        endpoint = path if not query else f"{path}?{query}"
        for matcher, spec in self.rest_scripts:
            matched = matcher(path, params or {}) if callable(matcher) else matcher == endpoint or matcher == path
            if matched:
                return self._materialize(spec, kind="rest", method="GET", endpoint=endpoint)
        raise LookupError(f"no fake REST response for GET {endpoint}")

    def graphql_query(self, query: str, variables: dict[str, Any] | None = None) -> HttpExchange:
        assert_graphql_query(query)
        for matcher, spec in self.graphql_scripts:
            matched = matcher(query, variables or {}) if callable(matcher) else True
            if matched:
                return self._materialize(spec, kind="graphql", method="POST", endpoint="graphql")
        raise LookupError("no fake GraphQL response")

    def rest_write(self, method: str, path: str) -> None:
        assert_rest_method(method)
        raise SafetyError(f"unreachable write {method} {path}")
