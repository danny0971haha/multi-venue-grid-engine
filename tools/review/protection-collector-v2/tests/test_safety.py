from __future__ import annotations

import json
import unittest

from lib.safety import SafetyError, assert_graphql_query, assert_rest_method, graphql_document_is_query
from lib.transport import FakeTransport


class SafetyTests(unittest.TestCase):
    def test_rest_get_allowed(self) -> None:
        assert_rest_method("GET")
        assert_rest_method("get")

    def test_rest_writes_forbidden(self) -> None:
        for method in ("POST", "PUT", "PATCH", "DELETE", "HEAD"):
            with self.subTest(method=method):
                with self.assertRaises(SafetyError):
                    assert_rest_method(method)

    def test_graphql_query_allowed(self) -> None:
        self.assertTrue(graphql_document_is_query("query { viewer { login } }"))
        self.assertTrue(graphql_document_is_query("query Foo($a: String) { repository { id } }"))
        self.assertTrue(graphql_document_is_query("{ viewer { login } }"))
        assert_graphql_query("query ProtectionCollectorV2BranchProtectionRules { viewer { login } }")

    def test_graphql_mutation_forbidden(self) -> None:
        with self.assertRaises(SafetyError):
            assert_graphql_query("mutation { createIssue(input: {}) { clientMutationId } }")
        self.assertFalse(graphql_document_is_query("mutation Add { addStar(input: {}) { clientMutationId } }"))

    def test_graphql_mutation_hidden_in_comment_still_query(self) -> None:
        self.assertTrue(graphql_document_is_query('query { viewer { login } } # mutation decoy'))

    def test_graphql_string_named_mutation_is_still_query(self) -> None:
        self.assertTrue(graphql_document_is_query('query { repository(name: "mutation") { id } }'))

    def test_fake_transport_rejects_rest_write(self) -> None:
        transport = FakeTransport()
        with self.assertRaises(SafetyError):
            transport.rest_write("POST", "repos/o/r/rulesets")

    def test_fake_transport_rejects_graphql_mutation(self) -> None:
        transport = FakeTransport()
        with self.assertRaises(SafetyError):
            transport.graphql_query("mutation { updateBranchProtectionRule(input: {}) { clientMutationId } }")
