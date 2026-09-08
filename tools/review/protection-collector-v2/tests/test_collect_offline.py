from __future__ import annotations

import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from lib.analyze import analyze
from lib.collect import CollectConfig, run_collection
from lib.packet import write_packet
from lib.redact import evidence_contains_secret
from lib.safety import SafetyError
from tests.scenario import EXPECTED_MAIN, LEAK_TOKEN, REVIEW_HEAD, REVIEW_TREE, ScriptedGithub

FROZEN = {
    'experiment/v0.1-phase2': '7f196d367e39640eee9517f742b0d61424f9d4cc',
    'experiment/v0.1-phase2e-halt-ack': '704afa2dd858c52dad06aa22941d463aa5ce4d69',
    'governance/phase2e-trusted-gate': '52445f4c2b3eb65f13ae00dbef80f07b417a7d53',
}

TOOL_ROOT = Path(__file__).resolve().parents[1]


def _config(tmp: Path) -> CollectConfig:
    return CollectConfig(
        owner="danny0971haha",
        repo="multi-venue-grid-engine",
        review_pr=11,
        expected_main=EXPECTED_MAIN,
        review_head=REVIEW_HEAD,
        review_tree=REVIEW_TREE,
        known_ruleset_id=21580900,
        expected_context="trusted-phase2d-freeze-gate",
        frozen_refs=[
            "experiment/v0.1-phase2",
            "experiment/v0.1-phase2e-halt-ack",
            "governance/phase2e-trusted-gate",
        ],
        out_dir=tmp / "packet",
        expected_frozen_refs=FROZEN.copy(),
    )


class OfflineCollectionTests(unittest.TestCase):
    def setUp(self):
        environment = patch('lib.collect.capture_environment', return_value={})
        environment.start()
        self.addCleanup(environment.stop)

    def test_single_and_multi_page_duplicate_and_enforcement_kinds(self) -> None:
        transport = ScriptedGithub("duplicate")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
        listed = bundle.sources["rulesets_includes_parents_true"]
        self.assertIn(21580900, listed.duplicates)
        ids = [row["id"] for row in listed.items]
        self.assertEqual(ids.count(21580900), 1)
        details = {row["id"]: row["body"]["enforcement"] for row in bundle.sources["ruleset_details"].items if row.get("body")}
        self.assertEqual(details[21580900], "active")
        self.assertEqual(details[10000001], "evaluate")
        self.assertEqual(details[10000002], "disabled")
        inherited = next(row for row in bundle.sources["ruleset_details"].items if row["id"] == 30000001)
        self.assertEqual(inherited["body"]["source_type"], "Organization")

    def test_same_context_different_integration_ids(self) -> None:
        transport = ScriptedGithub("conflict_non_main")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
        analysis = analyze(bundle)
        bindings = []
        for row in analysis["rulesets"]:
            for binding in row.get("expected_context_bindings") or []:
                bindings.append(binding.get("integration_id"))
        self.assertIn(15368, bindings)
        self.assertIn(99999, bindings)

    def test_classic_protection_on_non_main_and_pattern_conflict(self) -> None:
        transport = ScriptedGithub("conflict_non_main")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
            write_packet(bundle, transport.calls, tests={"result": "OFFLINE_HELPER"})
        classic = bundle.sources["classic_branch_protection_rest"]
        hit = next(row for row in classic.items if row["branch"] == "fix/multi-format-evidence-20260905")
        self.assertEqual(hit["http_class"], "OK")
        analysis = analyze(bundle)
        self.assertEqual(analysis["non_main_expected_context"]["conclusion"], "PRESENT")
        self.assertEqual(analysis["pr11_main_only_trigger"]["conflict"], "CONFLICT")
        patterns = [row["pattern"] for row in analysis["classic_patterns"]]
        self.assertIn("release/*", patterns)

    def test_main_only_complete_export_is_limited_not_sampled(self) -> None:
        transport = ScriptedGithub("bpr_empty")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
        analysis = analyze(bundle)
        self.assertIn("Full include/exclude", analysis["non_main_expected_context"]["method"])
        self.assertIn("Not inferred from a sample of branches", analysis["non_main_expected_context"]["method"])
        # evaluate ~ALL still recorded, but active/classic non-main context is absent
        self.assertEqual(analysis["non_main_expected_context"]["conclusion"], "NOT_PRESENT_IN_COMPLETE_EXPORT")
        self.assertEqual(analysis["pr11_main_only_trigger"]["conflict"], "NO_CONFLICT_IN_COMPLETE_EXPORT")
        self.assertTrue(analysis["non_main_expected_context"]["evaluate_or_disabled_hits"])

    def test_http_errors_are_gaps_not_absence(self) -> None:
        for mode, expected in [
            ("auth_401", "AUTH_FAILED"),
            ("list_403", "FORBIDDEN"),
            ("classic_403", "FORBIDDEN"),
            ("rate_limit", "RATE_LIMITED"),
            ("interrupt", "FORBIDDEN"),
            ("detail_404", "NOT_FOUND"),
        ]:
            with self.subTest(mode=mode):
                transport = ScriptedGithub(mode)
                with tempfile.TemporaryDirectory() as tmp:
                    bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
                analysis = analyze(bundle)
                if mode == "auth_401":
                    self.assertEqual(bundle.actor["http_class"], expected)
                if mode == "list_403":
                    self.assertEqual(bundle.sources["rulesets_includes_parents_true"].status, "FORBIDDEN")
                    self.assertNotEqual(analysis["non_main_expected_context"]["conclusion"], "NOT_PRESENT_IN_COMPLETE_EXPORT")
                    self.assertEqual(analysis["coverage_status"], "PARTIAL")
                if mode == "interrupt":
                    self.assertFalse(bundle.sources["rulesets_includes_parents_true"].pagination["complete"])
                    self.assertEqual(analysis["coverage_status"], "PARTIAL")
                if mode == "detail_404":
                    self.assertEqual(analysis["coverage_status"], "PARTIAL")
                if mode == "classic_403":
                    self.assertTrue(
                        any(row["http_class"] == "FORBIDDEN" for row in bundle.sources["classic_branch_protection_rest"].items)
                    )

    def test_malformed_effective_is_not_empty_rules(self) -> None:
        transport = ScriptedGithub("malformed_effective")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
        for item in bundle.sources["effective_ruleset_rules"].items:
            self.assertNotEqual(item.get("http_class"), "OK")
            self.assertIsNone(item.get("rules"))

    def test_drift_is_recorded_separately(self) -> None:
        transport = ScriptedGithub("drift")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
        self.assertTrue(bundle.drift["drift_detected"])
        self.assertEqual(bundle.identity_before["review_pr"]["head_sha"], REVIEW_HEAD)
        self.assertEqual(bundle.identity_after["review_pr"]["head_sha"], "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        self.assertNotEqual(bundle.identity_before["review_pr"]["head_sha"], bundle.identity_after["review_pr"]["head_sha"])

    def test_credentials_never_enter_packet(self) -> None:
        transport = ScriptedGithub("conflict_non_main")
        with tempfile.TemporaryDirectory() as tmp:
            bundle = run_collection(transport, _config(Path(tmp)), tool_root=TOOL_ROOT)
            write_packet(bundle, transport.calls, tests={"result": "PASS"})
            packet = Path(tmp) / "packet"
            for path in packet.rglob("*"):
                if not path.is_file():
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                self.assertNotIn(LEAK_TOKEN, text)
                self.assertFalse(evidence_contains_secret(text))
            ledger = json.loads((packet / "request-ledger.json").read_text(encoding="utf-8"))
            self.assertGreater(len(ledger["requests"]), 10)
            self.assertTrue((packet / "SHA256SUMS").exists())
            sums = (packet / "SHA256SUMS").read_text(encoding="utf-8")
            self.assertNotIn("SHA256SUMS", sums.split("SHA256SUMS")[0] if False else sums)
            self.assertNotIn("  SHA256SUMS\n", sums)
            status = json.loads((packet / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["ADOPTION"], "NOT_PERFORMED")
            self.assertEqual(status["TOOL_IMPLEMENTATION"], "CORRECTIVE_CANDIDATE_REQUIRES_INDEPENDENT_REVIEW")

    def test_rest_write_and_graphql_mutation_still_blocked_on_scripted_transport(self) -> None:
        transport = ScriptedGithub("conflict_non_main")
        with self.assertRaises(SafetyError):
            transport.rest_write("PUT", "repos/danny0971haha/multi-venue-grid-engine/rulesets/21580900")
        with self.assertRaises(SafetyError):
            transport.graphql_query("mutation { deleteBranchProtectionRule(input: {branchProtectionRuleId: \"x\"}) { clientMutationId } }")
