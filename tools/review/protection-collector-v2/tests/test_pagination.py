from __future__ import annotations

import unittest

from lib.pagination import graphql_pagination_status, merge_unique, next_page_number, rest_pagination_status


class PaginationTests(unittest.TestCase):
    def test_single_page_complete(self) -> None:
        status = rest_pagination_status(
            pages_fetched=1,
            last_status=200,
            last_item_count=1,
            next_page=None,
            per_page=100,
            max_pages=40,
        )
        self.assertTrue(status["complete"])

    def test_multi_page_then_complete(self) -> None:
        link = '<https://api.github.com/repos/o/r/rulesets?page=2>; rel="next", <https://api.github.com/repos/o/r/rulesets?page=2>; rel="last"'
        self.assertEqual(next_page_number(link), 2)
        status = rest_pagination_status(
            pages_fetched=2,
            last_status=200,
            last_item_count=3,
            next_page=None,
            per_page=100,
            max_pages=40,
        )
        self.assertTrue(status["complete"])

    def test_duplicate_items_recorded(self) -> None:
        items = [{"id": 1}, {"id": 2}, {"id": 1}]
        unique, duplicates = merge_unique(items, lambda row: row["id"])
        self.assertEqual([row["id"] for row in unique], [1, 2])
        self.assertEqual(duplicates, [1])

    def test_interrupted_pagination_not_complete(self) -> None:
        status = rest_pagination_status(
            pages_fetched=2,
            last_status=403,
            last_item_count=None,
            next_page=3,
            per_page=100,
            max_pages=40,
        )
        self.assertFalse(status["complete"])
        self.assertTrue(status["interrupted"])

    def test_graphql_incomplete_when_has_next(self) -> None:
        status = graphql_pagination_status(
            pages_fetched=1,
            last_ok=True,
            has_next_page=True,
            max_pages=40,
        )
        self.assertFalse(status["complete"])
