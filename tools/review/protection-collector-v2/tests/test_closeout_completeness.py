"""Reproduced incomplete REST protection and skipped-page regressions."""
import copy
import unittest

from lib.analyze import analyze
from lib.collect import collect_classic_and_effective, paginate_rest_list
from lib.transport import FakeTransport
from tests import test_corrective
from tests.test_corrective import ChangedGithub, cfg, ROOT
from tests.scenario import jload


class CloseoutCompletenessTests(unittest.TestCase):
    def test_truncated_admin_enforcement_blocks_completeness_preserves_rules(self):
        for value in (None, {}, {'enabled': None}, {'enabled': 'false'}, {'enabled': 0}):
            with self.subTest(value=value):
                def change(path, params, status, body, headers, transport):
                    if path.endswith('/protection'):
                        return 200, {'url': 'https://api.github.com/' + path,
                                     'enforce_admins': value}, {}
                    return status, body, headers
                bundle = test_corrective.CorrectiveTests().bundle(ChangedGithub(change))
                result = analyze(bundle)
                self.assertEqual(result['coverage_status'], 'PARTIAL')
                self.assertFalse(result['classic_rest_exact_names_interpretable'])
                self.assertTrue(result['confirmed'])
                self.assertEqual(result['non_main_expected_context']['conclusion'], 'UNKNOWN')

    def test_both_explicit_admin_enforcement_values_are_observations(self):
        for enabled in (False, True):
            body = copy.deepcopy(jload('rest/classic-non-main-200.json'))
            body['enforce_admins']['enabled'] = enabled
            transport = FakeTransport()
            transport.add_rest(lambda p, v: p.endswith('/protection'), {'status': 200, 'body': body})
            transport.add_rest(lambda p, v: '/rules/branches/' in p, {'status': 200, 'body': []})
            transport.add_rest(lambda p, v: True, {'status': 200, 'body': {}})
            classic, _, _ = collect_classic_and_effective(transport, cfg(), ['main'])
            self.assertEqual(classic.items[0]['http_class'], 'OK')

    def test_rest_next_cannot_skip_a_numbered_page(self):
        for next_page in (3, 10):
            transport = FakeTransport()
            transport.add_rest(lambda p, v: v['page'] == 1, {'status': 200,
                'body': [{'id': 1}], 'headers': {'Link':
                f'<https://api.github.com/{ROOT}/rulesets?page={next_page}>; rel="next"'}})
            transport.add_rest(lambda p, v: True, {'status': 200, 'body': []})
            result = paginate_rest_list(transport, ROOT + '/rulesets', {},
                key_fn=lambda row: row['id'], max_pages=3)
            self.assertFalse(result.pagination['complete'])
            self.assertEqual(result.items, [{'id': 1}])
            self.assertEqual(len(transport.calls), 1)


if __name__ == '__main__':
    unittest.main()
