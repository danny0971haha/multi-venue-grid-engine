"""Check actual query selection against the saved official live schema, not a mock."""
import json
import re
import unittest
from pathlib import Path
from lib.collect import BRANCH_PROTECTION_RULES_QUERY

SCHEMA = Path(__file__).resolve().parents[4] / 'docs/evidence/protection-v2-corrective-20260909/schema-response.json'


def validate_selection(document, schema):
    types = {t['name']: t for t in schema['data']['__schema']['types']}
    tokens = re.findall(r'\.\.\.|[A-Za-z_][A-Za-z_0-9]*|[{}():$!]|\d+', document)
    index = tokens.index('{') + 1
    checked = []

    def base_type(t):
        while not t.get('name'):
            t = t['ofType']
        return t['name']

    def selection(parent):
        nonlocal index
        fields = {f['name']:f for f in types[parent]['fields'] or []}
        while tokens[index] != '}':
            name=tokens[index];index+=1
            if name=='...':
                assert tokens[index]=='on';target=tokens[index+1];index+=2
                assert target in [p['name'] for p in types[parent]['possibleTypes']]
                assert tokens[index]=='{';index+=1
                selection(target)
                continue
            if name=='__typename':continue
            if name not in fields:raise AssertionError(f'{parent}.{name} missing from official schema')
            field=fields[name];checked.append(f'{parent}.{name}')
            if tokens[index]=='(':
                index+=1
                args={a['name'] for a in field['args']}
                while tokens[index]!=')':
                    arg=tokens[index];index+=1
                    assert arg in args, (parent,name,arg)
                    assert tokens[index]==':';index+=1
                    if tokens[index]=='$':index+=1
                    index+=1
                index+=1
            target=base_type(field['type'])
            if tokens[index]=='{':
                index+=1;selection(target)
            else:
                assert types[target]['kind'] in ('SCALAR','ENUM'),(parent,name,target)
        index+=1
    selection('Query')
    assert index==len(tokens)
    return checked


class SchemaContractTests(unittest.TestCase):
    def test_every_query_field_and_argument_in_official_schema(self):
        checked=validate_selection(BRANCH_PROTECTION_RULES_QUERY,json.loads(SCHEMA.read_text()))
        self.assertIn('RateLimit.resetAt',checked)
        self.assertGreater(len(checked),85)

    def test_old_rate_limit_reset_rejected_by_official_schema(self):
        with self.assertRaisesRegex(AssertionError,'RateLimit.reset'):
            validate_selection(BRANCH_PROTECTION_RULES_QUERY.replace('resetAt','reset'),json.loads(SCHEMA.read_text()))
