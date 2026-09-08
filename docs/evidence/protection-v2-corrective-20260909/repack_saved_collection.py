"""Offline, lossless-provenance packaging of the single saved acquisition.

No network. Does not relabel acquisition SHA/time or recompute historical results.
Only applies the corrected credential-prefix sanitizer and updates body hashes.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'tools/review/protection-collector-v2'
sys.path.insert(0, str(TOOL))
from lib.redact import redact_text, evidence_contains_secret
from lib.packet import write_sha256sums
from lib.safety import assert_graphql_query, assert_rest_method


def digest(data):
    return hashlib.sha256(data).hexdigest()


def repack(source, output, expected_source_sha):
    if output.exists():
        raise FileExistsError('refusing to overwrite any prior packet')
    manifest = json.loads((source / 'tool-manifest.json').read_text())
    if manifest['source_commit'] != expected_source_sha:
        raise ValueError('acquisition source SHA mismatch')
    # Reuse derived analysis only when its complete implementation bytes are identical.
    for name in ('lib/analyze.py', 'lib/collect.py', 'lib/validation.py', 'lib/patterns.py',
                 'lib/pagination.py', 'lib/transport.py', 'lib/safety.py', 'lib/packet.py', 'lib/constants.py'):
        if digest((TOOL / name).read_bytes()) != manifest['source_files_sha256'][name]:
            raise ValueError('analysis/acquisition implementation changed: ' + name)
    ledger = json.loads((source / 'request-ledger.json').read_text())
    for r in ledger['requests']:
        body = (source / 'raw' / (r['id'] + '.body')).read_bytes()
        if digest(body) != r['body_sha256'] or len(body) != r['body_bytes']:
            raise ValueError('saved raw body identity mismatch')
        if r['graphql']:
            assert r['method'] == 'POST' and r['endpoint'] == 'graphql'
            assert_graphql_query(r['extra']['query'])
        else:
            assert_rest_method(r['method'])
    source_hashes = {str(f.relative_to(source)): digest(f.read_bytes()) for f in sorted(source.rglob('*')) if f.is_file()}
    shutil.copytree(source, output)
    changes = []
    for r in ledger['requests']:
        file = output / 'raw' / (r['id'] + '.body')
        before = file.read_bytes()
        after = redact_text(before.decode()).encode()
        if before != after:
            file.write_bytes(after)
            changes.append({'path': str(file.relative_to(output)), 'before_sha256': digest(before),
                            'after_sha256': digest(after), 'reason': 'redact a bare credential prefix in public synthetic test code'})
        r['body_sha256'] = digest(after)
        r['body_bytes'] = len(after)
    (output / 'request-ledger.json').write_text(json.dumps(ledger, indent=2) + '\n')
    provenance = {'mode': 'OFFLINE_REPACK_NO_NETWORK', 'acquisition_source_commit': expected_source_sha,
                  'acquisition_started_at': ledger['started_at'], 'acquisition_finished_at': ledger['finished_at'],
                  'packaging_head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                  'packaging_tree': subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=ROOT,text=True).strip(),
                  'sanitizer_sha256': digest((TOOL/'lib/redact.py').read_bytes()),
                  'original_files_sha256': source_hashes, 'raw_changes': changes,
                  'analysis_implementation_unchanged': True,
                  'note': 'The initial network command exited 1 at evidence scan after all responses were saved. Its packet remains separate. Acquisition identities/times and derived analysis are not rewritten.'}
    (output / 'repack-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    for f in output.rglob('*'):
        if f.is_file() and evidence_contains_secret(f.read_text(errors='replace')):
            raise ValueError('evidence scan rejected ' + str(f.relative_to(output)))
    write_sha256sums(output)
    return {'network_requests': 0, 'saved_requests_verified': len(ledger['requests']), 'body_changes': changes,
            'output': str(output), 'packaging_head': provenance['packaging_head']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--expected-source-sha', required=True)
    args = parser.parse_args()
    print(json.dumps(repack(args.source, args.out, args.expected_source_sha), indent=2))
