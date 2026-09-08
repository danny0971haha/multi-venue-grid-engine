"""Required evidence shapes, distinct from transport success and empty collections."""
import re

SHA = re.compile(r"[0-9a-f]{40}\Z")
ALLOWANCES = ('bypassForcePushAllowances', 'bypassPullRequestAllowances',
              'pushAllowances', 'reviewDismissalAllowances')


def sha(value):
    return isinstance(value, str) and bool(SHA.fullmatch(value))


def obj(value):
    return value if isinstance(value, dict) else {}


def strings(value):
    return isinstance(value, list) and all(isinstance(x, str) for x in value)


def connection_errors(value):
    if not isinstance(value, dict):
        return ['connection missing/null/wrong type']
    errors = []
    nodes = value.get('nodes')
    info = obj(value.get('pageInfo'))
    count = value.get('totalCount')
    if not isinstance(nodes, list) or any(not isinstance(n, dict) for n in nodes):
        errors.append('nodes missing/null/wrong type')
    if type(count) is not int or count < 0:
        errors.append('totalCount missing/invalid')
    if type(info.get('hasNextPage')) is not bool or 'endCursor' not in info:
        errors.append('pageInfo missing/incomplete')
    elif info['hasNextPage'] and not isinstance(info['endCursor'], str):
        errors.append('endCursor missing')
    elif info['hasNextPage'] and not info['endCursor']:
        errors.append('endCursor empty')
    elif info['endCursor'] is not None and not isinstance(info['endCursor'], str):
        errors.append('endCursor invalid')
    return errors


def rule_errors(rule):
    if not isinstance(rule, dict) or not isinstance(rule.get('type'), str):
        return ['rule type missing/invalid']
    if rule['type'] in ('creation', 'deletion', 'required_linear_history', 'required_signatures', 'non_fast_forward'):
        return []
    if rule['type'] == 'pull_request':
        p = obj(rule.get('parameters'))
        keys = ('dismiss_stale_reviews_on_push', 'require_code_owner_review',
                'require_last_push_approval', 'required_review_thread_resolution')
        if type(p.get('required_approving_review_count')) is not int or any(type(p.get(k)) is not bool for k in keys):
            return ['pull_request parameters incomplete/invalid']
        return []
    if rule['type'] != 'required_status_checks':
        return ['unvalidated rule type: ' + rule['type']]
    p = obj(rule.get('parameters'))
    checks = p.get('required_status_checks')
    if not isinstance(checks, list) or any(
        not isinstance(c, dict) or not isinstance(c.get('context'), str) or
        ('integration_id' in c and c['integration_id'] is not None and type(c['integration_id']) is not int)
        for c in checks
    ) or type(p.get('strict_required_status_checks_policy')) is not bool:
        return ['required_status_checks parameters incomplete/invalid']
    return []


def ruleset_errors(body, expected_id=None, detail=True):
    if not isinstance(body, dict):
        return ['ruleset body missing/null/wrong type']
    errors = []
    if type(body.get('id')) is not int or (expected_id is not None and body['id'] != expected_id):
        errors.append('ruleset id missing/mismatch')
    for key in ('name', 'source', 'source_type'):
        if not isinstance(body.get(key), str) or not body[key]:
            errors.append(f'{key} missing/invalid')
    if body.get('enforcement') not in ('active', 'evaluate', 'disabled'):
        errors.append('enforcement missing/invalid')
    if not detail:
        return errors
    if body.get('target') not in ('branch', 'tag', 'push', 'repository'):
        errors.append('target missing/unknown')
    if body.get('target') in ('branch', 'tag'):
        ref = obj(obj(body.get('conditions')).get('ref_name'))
        if not strings(ref.get('include')) or not strings(ref.get('exclude')):
            errors.append('ref_name include/exclude missing/invalid')
    rules = body.get('rules')
    if not isinstance(rules, list):
        errors.append('rules missing/null/invalid')
    else:
        for r in rules:
            errors.extend(rule_errors(r))
    bypass = body.get('bypass_actors')
    if not isinstance(bypass, list):
        errors.append('bypass_actors omitted/null/invalid; not an empty bypass list')
    elif any(not isinstance(a, dict) or not isinstance(a.get('actor_type'), str) or
             not isinstance(a.get('bypass_mode'), str) or 'actor_id' not in a for a in bypass):
        errors.append('bypass actor incomplete')
    return errors


def pr_errors(pr):
    if not isinstance(pr, dict):
        return ['PR missing/invalid']
    errors = []
    if type(pr.get('number')) is not int:
        errors.append('PR number missing')
    for side in ('head', 'base'):
        part = obj(pr.get(side))
        if not isinstance(part.get('ref'), str) or not sha(part.get('sha')):
            errors.append(f'PR {side} ref/sha missing/invalid')
    return errors


def bpr_errors(node):
    if not isinstance(node, dict):
        return ['rule node null/invalid']
    errors = []
    for key in ('id', 'pattern'):
        if not isinstance(node.get(key), str) or not node[key]:
            errors.append(f'{key} missing/invalid')
    for key in ('isAdminEnforced', 'requiresStatusChecks', 'requiresStrictStatusChecks',
                'requiresApprovingReviews', 'requiresCodeOwnerReviews',
                'requiresConversationResolution', 'requiresCommitSignatures',
                'requiresLinearHistory', 'requireLastPushApproval', 'allowsForcePushes',
                'allowsDeletions', 'lockBranch', 'lockAllowsFetchAndMerge', 'blocksCreations',
                'restrictsPushes', 'restrictsReviewDismissals', 'dismissesStaleReviews', 'requiresDeployments'):
        if type(node.get(key)) is not bool:
            errors.append(f'{key} missing/invalid')
    if type(node.get('requiredApprovingReviewCount')) is not int:
        errors.append('requiredApprovingReviewCount missing/invalid')
    for key in ('requiredStatusCheckContexts', 'requiredDeploymentEnvironments'):
        if not strings(node.get(key)):
            errors.append(f'{key} missing/invalid')
    checks = node.get('requiredStatusChecks')
    if not isinstance(checks, list) or any(not isinstance(c, dict) or
        not isinstance(c.get('context'), str) or 'app' not in c or
        (c['app'] is not None and (not isinstance(c['app'], dict) or
         not {'databaseId', 'name', 'slug'} <= c['app'].keys() or
         (c['app']['databaseId'] is not None and type(c['app']['databaseId']) is not int))) for c in checks):
        errors.append('requiredStatusChecks missing/invalid')
    matching = obj(node.get('matchingRefs'))
    if type(matching.get('totalCount')) is not int or type(obj(matching.get('pageInfo')).get('hasNextPage')) is not bool:
        errors.append('matchingRefs count connection missing/invalid')
    for key in ALLOWANCES:
        conn = node.get(key)
        ce = connection_errors(conn)
        errors.extend(f'{key}: {e}' for e in ce)
        if ce:
            continue
        actors = [obj(n.get('actor')) for n in conn['nodes']]
        keys = [a.get('id') for a in actors]
        if any(not isinstance(k, str) or not k for k in keys) or len(keys) != len(set(keys)):
            errors.append(f'{key}: missing/duplicate actor identity')
        if conn['pageInfo']['hasNextPage'] or len(actors) != conn['totalCount']:
            errors.append(f'{key}: allowance pagination incomplete/count mismatch')
    return errors


def effective_rule_errors(rule):
    errors = rule_errors(rule)
    rule = obj(rule)
    if type(rule.get('ruleset_id')) is not int or not isinstance(rule.get('ruleset_source'), str) or rule.get('ruleset_source_type') not in ('Repository', 'Organization', 'Enterprise'):
        errors.append('effective rule provenance missing/invalid')
    return errors
