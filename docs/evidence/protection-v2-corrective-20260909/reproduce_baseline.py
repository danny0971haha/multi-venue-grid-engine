"""Read immutable baseline lib bytes into a temporary directory; never touch refs."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

BASE='b2ea605d5ed507b634f9a2ee5907db39bf129d13'
PREFIX='tools/review/protection-collector-v2/'
with tempfile.TemporaryDirectory() as tmp:
    for file in subprocess.check_output(['git','ls-tree','-r','--name-only',BASE,'--',PREFIX+'lib'],text=True).splitlines():
        p=Path(tmp)/file.removeprefix(PREFIX);p.parent.mkdir(parents=True,exist_ok=True)
        p.write_bytes(subprocess.check_output(['git','show',BASE+':'+file]))
    sys.path.insert(0,tmp)
    from lib.collect import CollectConfig, capture_identity, collect_branch_protection_rules, collect_ruleset_details, paginate_rest_list, SourceResult, CollectionBundle
    from lib.transport import FakeTransport
    from lib.analyze import analyze
    c=CollectConfig('danny0971haha','multi-venue-grid-engine',11,'1'*40,'2'*40,'3'*40,21580900,'trusted-phase2d-freeze-gate',[],Path(tmp)/'unused')
    t=FakeTransport()
    root='repos/danny0971haha/multi-venue-grid-engine'
    t.add_rest(root,{'status':200,'body':{'owner':{'type':'User'},'default_branch':'main'}})
    t.add_rest(root+'/pulls/11',{'status':200,'body':{'number':11,'head':{'sha':'a'*40},'base':{'ref':'main','sha':'1'*40}}})
    t.add_rest(root+'/pulls',{'status':200,'body':[]})
    t.add_rest(root+'/commits/'+'1'*40,{'status':200,'body':{'sha':'1'*40,'commit':{'tree':{'sha':'4'*40}}}})
    t.add_rest(root+'/commits/'+'2'*40,{'status':200,'body':{'sha':'2'*40,'commit':{'tree':{'sha':'3'*40}}}})
    t.add_rest(root+'/git/ref/heads/main',{'status':200,'body':{'ref':'refs/heads/main','object':{'type':'commit','sha':'b'*40}}})
    t.add_rest('rate_limit',{'status':200,'body':{}})
    identity=capture_identity(t,c,'before')
    results={'baseline':BASE,'identity':identity,'actual_main_ref_requested':any('/git/ref/' in x.endpoint for x in t.calls)}
    t=FakeTransport();t.add_graphql(True,{'status':200,'body':{'data':{'repository':{}}}})
    r=collect_branch_protection_rules(t,c)
    results['missing_graphql_connection']={'status':r.status,'complete':r.pagination['complete'],'items':r.items}
    t=FakeTransport();t.add_rest(lambda p,v:True,{'status':200,'body':{}})
    r=collect_ruleset_details(t,c,[21580900]);results['ruleset_200_empty_object']=r.status
    r=paginate_rest_list(t,root+'/rulesets',{},key_fn=lambda r:r['id'],max_pages=40)
    results['rest_200_object_instead_of_array']={'status':r.status,'complete':r.pagination['complete']}
    classic=SourceResult('classic',[],'COLLECTED',[404],items=[{'branch':'main','http_class':'CLASSIC_NOT_PROTECTED_MESSAGE'}])
    b=CollectionBundle(c,'offline',None,{}, {'permissions':{'accepted_github_permissions':'administration=read'}},
        {'default_branch':'main'},{},{}, {'classic_branch_protection_rest':classic},['main'],[],[])
    results['required_header_only_absence_claim']=analyze(b)['classic_not_protected_exact_names']
    print(json.dumps(results,indent=2))
