#!/usr/bin/env python3
"""Read-only GitHub protection collector v2 (independent new tool)."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

TOOL_ROOT = Path(__file__).resolve().parent
if str(TOOL_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOL_ROOT))

from lib.collect import CollectConfig, run_collection  # noqa: E402
from lib.constants import IDENTITY_DISCLAIMER, VERSION  # noqa: E402
from lib.packet import write_packet  # noqa: E402
from lib.transport import GhTransport  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Independent read-only protection collector v2. "
            "Not a restoration of any prior collector."
        )
    )
    parser.add_argument("--repo", required=True, help="owner/name")
    parser.add_argument("--review-pr", required=True, type=int)
    parser.add_argument("--expected-main", required=True)
    parser.add_argument("--review-head", required=True)
    parser.add_argument("--review-tree", required=True)
    parser.add_argument("--known-ruleset-id", required=True, type=int)
    parser.add_argument("--expected-context", required=True)
    parser.add_argument("--frozen-ref", action="append", default=[], help="NAME=EXPECTED_SHA; unbound NAME remains UNVERIFIED")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--version", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print(VERSION)
        print(IDENTITY_DISCLAIMER)
        return 0
    if "/" not in args.repo:
        parser.error("--repo must be owner/name")
    owner, name = args.repo.split("/", 1)
    config = CollectConfig(
        owner=owner,
        repo=name,
        review_pr=args.review_pr,
        expected_main=args.expected_main,
        review_head=args.review_head,
        review_tree=args.review_tree,
        known_ruleset_id=args.known_ruleset_id,
        expected_context=args.expected_context,
        frozen_refs=args.frozen_ref,
        out_dir=args.out,
    )
    transport = GhTransport()
    bundle = run_collection(transport, config, tool_root=TOOL_ROOT)
    write_packet(bundle, transport.calls)
    print(f"wrote {config.out_dir}")
    print(IDENTITY_DISCLAIMER)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
