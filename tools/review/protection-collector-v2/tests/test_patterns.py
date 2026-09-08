from __future__ import annotations

import unittest

from lib.patterns import (
    classic_pattern_matches_branch,
    github_fnmatch,
    pattern_scope,
    ruleset_applies_to_ref,
    ruleset_non_default_possible,
)


class PatternTests(unittest.TestCase):
    def test_fnmatch_star_does_not_cross_slash(self) -> None:
        self.assertTrue(github_fnmatch("refs/heads/main", "refs/heads/main"))
        self.assertTrue(github_fnmatch("refs/heads/dev", "refs/heads/*"))
        self.assertFalse(github_fnmatch("refs/heads/qa/foo", "refs/heads/*"))
        self.assertTrue(github_fnmatch("refs/heads/qa/foo/bar", "refs/heads/qa/**/*"))

    def test_default_and_all_tokens(self) -> None:
        conditions = {"ref_name": {"include": ["refs/heads/main"], "exclude": []}}
        self.assertTrue(ruleset_applies_to_ref(conditions, "refs/heads/main", "main"))
        self.assertFalse(ruleset_applies_to_ref(conditions, "refs/heads/feature", "main"))
        self.assertEqual(ruleset_non_default_possible(conditions, "main"), "only_default")
        all_conditions = {"ref_name": {"include": ["~ALL"], "exclude": []}}
        self.assertEqual(ruleset_non_default_possible(all_conditions, "main"), "can_match_non_default")

    def test_exclude(self) -> None:
        conditions = {"ref_name": {"include": ["~ALL"], "exclude": ["refs/heads/main"]}}
        self.assertFalse(ruleset_applies_to_ref(conditions, "refs/heads/main", "main"))
        self.assertTrue(ruleset_applies_to_ref(conditions, "refs/heads/dev", "main"))

    def test_classic_star_matches_all_branches(self) -> None:
        self.assertTrue(classic_pattern_matches_branch("*", "main"))
        self.assertTrue(classic_pattern_matches_branch("*", "feature/x"))
        self.assertEqual(pattern_scope("*", kind="classic", default_branch="main"), "can_match_non_default")
        self.assertEqual(pattern_scope("main", kind="classic", default_branch="main"), "only_default")
        self.assertEqual(pattern_scope("release/*", kind="classic", default_branch="main"), "can_match_non_default")
