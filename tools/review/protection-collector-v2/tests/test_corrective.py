"""Minimal counterexamples for identity, completeness and permission regressions."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from lib.analyze import analyze
from lib.collect import (capture_identity, compare_identity, collect_branch_protection_rules,
    collect_ruleset_details, collect_classic_and_effective, paginate_rest_list, run_collection,
    collect_org_or_enterprise_probe, BRANCH_PROTECTION_RULES_QUERY)
from lib.packet import classify_live, write_packet
from lib.patterns import pattern_scope
from lib.transport import FakeTransport, GhTransport
from lib.validation import ALLOWANCES, pr_errors, ruleset_errors
from tests.scenario import ScriptedGithub, jload, EXPECTED_MAIN, REVIEW_HEAD, REVIEW_TREE
from tests.test_collect_offline import _config, TOOL_ROOT, FROZEN

ROOT = 'repos/danny0971haha/multi-venue-grid-engine'
OTHER = 'a' * 40
TREE = 'b' * 40


def cfg():
    return _config(Path('/unused-offline'))


def gql(body, config=None):
    t = FakeTransport()
    t.add_graphql(True, {'status': 200, 'body': body})
    return collect_branch_protection_rules(t, config or cfg())


def empty_gql():
    p = jload('graphql/bpr-page1.json')
    p['data']['repository']['branchProtectionRules'] = {'nodes': [], 'totalCount': 0,
        'pageInfo': {'hasNextPage': False, 'endCursor': None}}
    return p


class ChangedGithub(ScriptedGithub):
    def __init__(self, change):
        super().__init__('bpr_empty')
        self.change = change

    def _route_rest(self, path, params):
        status, body, headers = super()._route_rest(path, params)
        return self.change(path, params, status, copy.deepcopy(body), headers, self)


class CorrectiveTests(unittest.TestCase):
    def bundle(self, t=None):
        with patch('lib.collect.capture_environment', return_value={}):
            return run_collection(t or ScriptedGithub('bpr_empty'), cfg(), tool_root=TOOL_ROOT)

    def test_graphql_missing_null_or_invalid_connection_never_complete(self):
        for field in ('repository', 'branchProtectionRules', 'nodes', 'pageInfo', 'totalCount'):
            for value in (None, {}, 'bad'):
                with self.subTest(field=field, value=value):
                    p = empty_gql()
                    if field == 'repository':
                        p['data'][field] = value
                    elif field == 'branchProtectionRules':
                        p['data']['repository'][field] = value
                    else:
                        p['data']['repository']['branchProtectionRules'][field] = value
                    self.assertFalse(gql(p).pagination['complete'])
            p = empty_gql()
            container = p['data'] if field == 'repository' else p['data']['repository'] if field == 'branchProtectionRules' else p['data']['repository']['branchProtectionRules']
            del container[field]
            self.assertFalse(gql(p).pagination['complete'])

    def test_graphql_genuine_empty_is_complete(self):
        r = gql(empty_gql())
        self.assertEqual(r.status, 'OK')
        self.assertTrue(r.pagination['validated_empty_collection'])

    def test_graphql_errors_and_partial_data_preserve_seen_rules(self):
        p = jload('graphql/bpr-page1.json'); p['errors'] = [{'message': 'denied'}]
        r = gql(p)
        self.assertFalse(r.pagination['complete'])
        self.assertEqual(r.items[0]['id'], 'BPR_MAIN')
        self.assertTrue(r.extra['graphql_errors'])

    def test_graphql_cursor_duplicates_missing_cursor_and_count_mismatch(self):
        p = jload('graphql/bpr-page1.json')
        for case in ('repeat', 'missing', 'count', 'duplicate'):
            with self.subTest(case=case):
                q = copy.deepcopy(p)
                c = q['data']['repository']['branchProtectionRules']
                if case == 'missing': del c['pageInfo']['endCursor']
                if case == 'count': c['pageInfo']['hasNextPage'] = False
                if case == 'duplicate': c['nodes'] *= 2; c['pageInfo']['hasNextPage'] = False
                r = gql(q)
                self.assertNotEqual(r.status, 'OK')
                self.assertFalse(r.pagination['complete'])
                self.assertLessEqual(len(r.exchanges), 2)

    def test_graphql_total_changes_between_pages(self):
        t = FakeTransport(); p = jload('graphql/bpr-page1.json'); q = jload('graphql/bpr-page2.json')
        q['data']['repository']['branchProtectionRules']['totalCount'] = 3
        t.add_graphql(lambda q,v: v['cursor'] is None, {'status':200,'body':p})
        t.add_graphql(lambda q,v: v['cursor'] is not None, {'status':200,'body':q})
        r = collect_branch_protection_rules(t,cfg())
        self.assertFalse(r.pagination['complete'])
        self.assertIn('totalCount moved across pages',r.notes)

    def test_allowances_incomplete_missing_duplicate_and_count_never_empty(self):
        for key in ALLOWANCES:
            for case in ('null', 'missing', 'truncated', 'count', 'duplicate'):
                with self.subTest(key=key, case=case):
                    p = jload('graphql/bpr-page1.json'); c = p['data']['repository']['branchProtectionRules']
                    c['totalCount']=1; c['pageInfo']['hasNextPage']=False
                    node=c['nodes'][0]
                    if case=='null': node[key]=None
                    elif case=='missing': del node[key]
                    elif case=='truncated': node[key]['pageInfo'].update(hasNextPage=True,endCursor='more')
                    elif case=='count': node[key]['totalCount']=1
                    else: node[key].update(nodes=[{'actor':{'id':'u'}}]*2,totalCount=2)
                    self.assertFalse(gql(p).pagination['complete'])

    def test_graphql_midpage_http_failures_and_malformed(self):
        for status,body in [(403,{}),(404,{}),(429,{}),(500,{}),(200,'{broken')]:
            with self.subTest(status=status):
                t=FakeTransport()
                t.add_graphql(lambda q,v:v['cursor'] is None,{'status':200,'body':jload('graphql/bpr-page1.json')})
                t.add_graphql(lambda q,v:v['cursor'] is not None,{'status':status,'body':body})
                r=collect_branch_protection_rules(t,cfg())
                self.assertFalse(r.pagination['complete']); self.assertEqual(len(r.items),1)

    def test_rest_pr_ruleset_and_effective_pagination_failure_matrix(self):
        for path,key in [(ROOT+'/pulls','number'),(ROOT+'/rulesets','id'),(ROOT+'/rules/branches/main','id')]:
            for status,body in [(403,{}),(404,{}),(429,{}),(500,{}),(200,'{broken'),(200,{}),(200,None)]:
                with self.subTest(path=path,status=status,body=body):
                    t=FakeTransport()
                    t.add_rest(lambda p,v:v['page']==1,{'status':200,'body':[{key:1}], 'headers':{'Link':'<https://api.github.com/x?page=2>; rel="next"'}})
                    t.add_rest(lambda p,v:v['page']==2,{'status':status,'body':body})
                    r=paginate_rest_list(t,path,{},key_fn=lambda r:r.get(key),max_pages=3)
                    self.assertFalse(r.pagination['complete']); self.assertEqual(r.items,[{key:1}])

    def test_rest_duplicate_nonforward_and_bad_link(self):
        for link in ['<https://api.github.com/x?page=1>; rel="next"', '<https://api.github.com/x?page=bad>; rel="next"', 'broken']:
            t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':[{'id':1}],'headers':{'Link':link}})
            r=paginate_rest_list(t,ROOT+'/rulesets',{},key_fn=lambda r:r['id'],max_pages=3)
            self.assertFalse(r.pagination['complete']);self.assertEqual(len(t.calls),1)
        t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':[{'id':1},{'id':1}]})
        r=paginate_rest_list(t,ROOT+'/rulesets',{},key_fn=lambda r:r['id'],max_pages=3)
        self.assertFalse(r.pagination['complete']);self.assertEqual(r.duplicates,[1])

    def test_rest_empty_valid_on_last_allowed_page(self):
        t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':[]})
        r=paginate_rest_list(t,ROOT+'/rulesets',{},key_fn=lambda r:r['id'],max_pages=1)
        self.assertTrue(r.pagination['complete']);self.assertTrue(r.pagination['validated_empty_collection'])

    def test_ruleset_200_missing_required_fields_is_incomplete(self):
        for key in ('id','name','target','source','source_type','enforcement','conditions','rules','bypass_actors'):
            for value in ('missing',None):
                with self.subTest(key=key,value=value):
                    body=jload('rest/ruleset-active-main.json')
                    if value=='missing': del body[key]
                    else: body[key]=value
                    t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':body})
                    r=collect_ruleset_details(t,cfg(),[21580900])
                    self.assertNotEqual(r.status,'OK');self.assertFalse(r.items[0]['complete'])
        for body in ({},None,[],{'id':21580900,'rules':[]}):
            t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':body})
            self.assertNotEqual(collect_ruleset_details(t,cfg(),[21580900]).status,'OK')

    def test_main_ref_mismatch_before_not_hidden_by_existing_expected_commit(self):
        def change(path,params,status,body,headers,t):
            if '/git/ref/heads/main' in path: body['object']['sha']=OTHER
            return status,body,headers
        t=ChangedGithub(change); i=capture_identity(t,cfg(),'before')
        self.assertEqual(i['main']['sha'],OTHER); self.assertEqual(i['main']['tree'],TREE)
        self.assertEqual(i['expected']['expected_main'],EXPECTED_MAIN);self.assertFalse(i['match']['main'])
        self.assertFalse(i['complete'])

    def test_observed_pr_head_tree_come_from_same_sha(self):
        def change(path,params,status,body,headers,t):
            if path.endswith('/pulls/11'): body['head']['sha']=OTHER
            return status,body,headers
        i=capture_identity(ChangedGithub(change),cfg(),'before')
        self.assertEqual((i['review_pr']['head_sha'],i['review_pr']['head_tree']),(OTHER,TREE))
        self.assertNotEqual(i['review_pr']['head_tree'],REVIEW_TREE)

    def test_identity_midrun_moves_main_pr_base_and_each_frozen_ref(self):
        for target in ['main',*FROZEN,'pr_head','pr_base']:
            with self.subTest(target=target):
                def change(path,params,status,body,headers,t):
                    if t.pr_reads>=2:
                        if target in ['main',*FROZEN] and path.endswith('/git/ref/heads/'+target):body['object']['sha']=OTHER
                        if target=='pr_head' and path.endswith('/pulls/11'):body['head']['sha']=OTHER
                        if target=='pr_base' and path.endswith('/pulls/11'):body['base']['sha']=OTHER
                    return status,body,headers
                b=self.bundle(ChangedGithub(change));self.assertTrue(b.drift['drift_detected']);self.assertFalse(b.drift['identity_verified'])
                a=analyze(b);self.assertEqual(a['coverage_status'],'PARTIAL');self.assertEqual(a['classic_not_protected_exact_names'],[])
                self.assertEqual(classify_live(b,a),'PARTIAL')

    def test_identity_http_missing_and_wrong_commit_do_not_supply_tree(self):
        for status,body in [(403,{}),(404,{}),(500,{}),(200,{}),(200,{'sha':OTHER,'commit':{'tree':{'sha':TREE}}})]:
            with self.subTest(status=status,body=body):
                def change(path,params,s,b,h,t):
                    return (status,body,h) if path.endswith('/commits/'+REVIEW_HEAD) else (s,b,h)
                i=capture_identity(ChangedGithub(change),cfg(),'before')
                self.assertIsNone(i['review_pr']['head_tree']);self.assertFalse(i['complete'])

    def test_open_prs_multipage_collected_and_interruption_blocks_identity(self):
        for fail in (False,True):
            def change(path,params,status,body,headers,t):
                if path.endswith('/pulls'):
                    if params['page']==1:return 200,body[:1],{'Link':'<https://api.github.com/x?page=2>; rel="next"'}
                    if fail:return 403,{},{}
                    return 200,body[1:],{}
                return status,body,headers
            i=capture_identity(ChangedGithub(change),cfg(),'before')
            self.assertEqual(i['open_prs_pagination']['complete'],not fail)
            self.assertEqual(i['complete'],not fail)

    def test_endpoint_permission_header_and_oauth_scope_are_not_caller_admin(self):
        b=self.bundle();self.assertEqual(analyze(b)['coverage_status'],'COMPLETE_FOR_APPLICABLE_SOURCES')
        for grants in (None,{}, {'admin':False}):
            with self.subTest(grants=grants):
                x=copy.deepcopy(b)
                x.actor['permissions']={'oauth_scopes':['repo'],'accepted_github_permissions':'administration=read',
                                        'endpoint_required_github_permissions':'administration=read'}
                x.identity_before['repository_permissions']=grants;x.identity_after['repository_permissions']=grants
                a=analyze(x);self.assertFalse(a['caller_repository_admin_observed'])
                self.assertEqual(a['classic_not_protected_exact_names'],[])
                self.assertEqual(a['non_main_expected_context']['conclusion'],'UNKNOWN')

    def test_product_nonapplicability_needs_ownership_nonfork_and_documentation(self):
        b=self.bundle();i=b.identity_before
        r=collect_org_or_enterprise_probe(FakeTransport(),cfg(),i)
        self.assertEqual(r.status,'NOT_APPLICABLE');self.assertTrue(r.extra['documentation']);self.assertTrue(r.extra['ownership_exchange_id'])
        for key,value in [('owner_type','Organization'),('owner_type',None),('fork',True),('fork',None),('repository_http_class','NOT_FOUND'),('repository_full_name','wrong/repo')]:
            x=copy.deepcopy(i);x[key]=value
            self.assertNotEqual(collect_org_or_enterprise_probe(FakeTransport(),cfg(),x).status,'NOT_APPLICABLE')
        b=self.bundle(ScriptedGithub('conflict_non_main'))
        self.assertNotEqual(b.sources['org_or_enterprise_probe'].status,'NOT_APPLICABLE')

    def test_missing_permission_bypass_and_partial_data_keep_positive_observations(self):
        b=self.bundle();item=b.sources['ruleset_details'].items[0]
        del item['body']['bypass_actors'];item['complete']=False
        b.sources['ruleset_details'].status='INCOMPLETE'
        a=analyze(b);self.assertEqual(a['coverage_status'],'PARTIAL')
        self.assertTrue(any(r.get('expected_context_bindings') for r in a['confirmed']))

    def test_complex_main_pattern_cannot_be_main_only_from_samples(self):
        for kind,pattern in [('classic','ma?n'),('ruleset','refs/heads/ma?n')]:
            self.assertEqual(pattern_scope(pattern,kind=kind,default_branch='main'),'unknown')

    def test_timeout_and_os_failure_are_recordable_http_gaps(self):
        import subprocess
        for error in [FileNotFoundError(),subprocess.TimeoutExpired('gh',1)]:
            with patch('lib.transport.subprocess.run',side_effect=error):
                t=GhTransport();r=t.rest_get(ROOT)
                self.assertGreaterEqual(r.status,500);self.assertEqual(len(t.calls),1)
                r=t.graphql_query('query { viewer { login } }');self.assertGreaterEqual(r.status,500)

    def test_packet_never_overwrites_prior_input_missing(self):
        b=self.bundle()
        with tempfile.TemporaryDirectory() as tmp:
            b.config.out_dir=Path(tmp)
            original=Path(tmp)/'INPUT_MISSING';original.write_text('historical')
            with self.assertRaises(FileExistsError):write_packet(b,[])
            self.assertEqual(original.read_text(),'historical')

    def test_rate_limit_contract_uses_reset_at(self):
        self.assertIn('resetAt',BRANCH_PROTECTION_RULES_QUERY)
        self.assertNotIn(' reset ',BRANCH_PROTECTION_RULES_QUERY)


class AdditionalBoundaryTests(unittest.TestCase):
    def test_real_transport_rejects_mutations_before_subprocess(self):
        from lib.safety import SafetyError
        for query in ['mutation { deleteRepository(input: {}) { clientMutationId } }',
                      '# "\nmutation { deleteRepository(input: {}) { clientMutationId } }\n# "\nquery { viewer { login } }',
                      'query { viewer { login } } mutation { deleteRepository(input: {}) { clientMutationId } }']:
            with patch('lib.transport.subprocess.run') as run:
                with self.assertRaises(SafetyError): GhTransport().graphql_query(query)
                run.assert_not_called()

    def test_missing_ref_response_and_invalid_ruleset_ids_are_recorded(self):
        def change(path,params,status,body,headers,t):
            if '/git/ref/heads/' in path:return 200,{},{}
            return status,body,headers
        i=capture_identity(ChangedGithub(change),cfg(),'before')
        self.assertFalse(i['complete']); self.assertIsNone(i['main']['sha'])
        t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':[{'id':{}},{'id':None},None]})
        r=paginate_rest_list(t,ROOT+'/rulesets',{},key_fn=lambda r:r.get('id'),max_pages=1,
                            validate_item=lambda r:ruleset_errors(r,detail=False))
        self.assertFalse(r.pagination['complete'])

    def test_effective_incomplete_keeps_seen_hits_but_no_empty_absence(self):
        class EffectivePartial(ScriptedGithub):
            def _route_rest(self,path,params):
                if '/rules/branches/' in path:
                    if params['page']==1:
                        rule=jload('rest/ruleset-active-main.json')['rules'][0]
                        rule.update(ruleset_id=21580900,ruleset_source_type='Repository',ruleset_source='danny0971haha/multi-venue-grid-engine')
                        return 200,[rule],{'Link':'<https://api.github.com/x?page=2>; rel="next"'}
                    return 403,{},{}
                return super()._route_rest(path,params)
        with patch('lib.collect.capture_environment',return_value={}):
            b=run_collection(EffectivePartial('bpr_empty'),cfg(),tool_root=TOOL_ROOT)
        r=b.sources['effective_ruleset_rules'].items[0]
        self.assertIsNone(r['rules']);self.assertTrue(r['observed_rules']);self.assertFalse(r['pagination']['complete'])
        self.assertEqual(analyze(b)['coverage_status'],'PARTIAL')

    def test_bpr_missing_matching_count_or_malformed_actor_is_incomplete(self):
        for case in ('matching', 'actor'):
            p=jload('graphql/bpr-page1.json');c=p['data']['repository']['branchProtectionRules'];c['totalCount']=1;c['pageInfo']['hasNextPage']=False
            n=c['nodes'][0]
            if case=='matching':n['matchingRefs']=None
            else:n['pushAllowances'].update(totalCount=1,nodes=[{'actor':{'id':{}}}])
            self.assertFalse(gql(p).pagination['complete'])
