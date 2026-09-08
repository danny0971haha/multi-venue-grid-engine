from __future__ import annotations

import json
import unittest

from lib.redact import evidence_contains_secret, redact_headers, redact_json_value, redact_text


class RedactTests(unittest.TestCase):
    def test_token_prefixes_redacted(self) -> None:
        text = "Authorization: token gho_ABCDEFG1234567890"
        self.assertNotIn("gho_ABCDEFG", redact_text(text))
        self.assertIn("[REDACTED_TOKEN]", redact_text(text))

    def test_headers_drop_authorization(self) -> None:
        headers = redact_headers(
            {
                "Authorization": "Bearer gho_ABCDEFG1234567890",
                "X-OAuth-Scopes": "repo, workflow",
                "X-RateLimit-Remaining": "4999",
                "Link": '<https://api.github.com/repos/o/r/rulesets?page=2>; rel="next"',
            }
        )
        self.assertNotIn("Authorization", headers)
        self.assertEqual(headers["X-OAuth-Scopes"], "repo, workflow")
        dumped = json.dumps(headers)
        self.assertFalse(evidence_contains_secret(dumped))

    def test_masked_gh_status_token_is_redacted(self) -> None:
        text = "Token: gho_************************************"
        redacted = redact_text(text)
        self.assertIn("[REDACTED_TOKEN]", redacted)
        self.assertNotIn("gho_", redacted)
        self.assertFalse(evidence_contains_secret(redacted))

    def test_json_token_fields_redacted(self) -> None:
        payload = {"token": "gho_ABCDEFG1234567890", "login": "danny0971haha"}
        redacted = redact_json_value(payload)
        self.assertEqual(redacted["token"], "[REDACTED]")
        self.assertEqual(redacted["login"], "danny0971haha")

    def test_bare_prefix_in_public_synthetic_source_is_redacted(self) -> None:
        text = 'const planted = `ghp_${"a".repeat(36)}`;'
        result = redact_text(text)
        self.assertIn('[REDACTED_TOKEN]', result)
        self.assertFalse(evidence_contains_secret(result))
