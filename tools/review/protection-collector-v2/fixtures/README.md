These fixtures are synthetic HTTP bodies for offline collector v2 tests.

They are not live GitHub exports and are not PR #11 adoption evidence.
A live packet, if produced, lives under docs/evidence/owner-protection-v2-* and has its own identity/time.

Covered cases:

- rest/rulesets-page1.json + rest/rulesets-page2.json: multi-page list
- rest/rulesets-page2-duplicate.json: duplicate id across pages
- rest/ruleset-active-main.json: active, include refs/heads/main
- rest/ruleset-evaluate.json: evaluate enforcement
- rest/ruleset-disabled.json: disabled enforcement
- rest/ruleset-inherited.json: Organization source_type
- rest/ruleset-same-context-app-a.json and app-b.json: same context, different integration_id
- graphql/bpr-page1.json + bpr-page2.json: classic patterns including non-main
- rest/classic-non-main-200.json: traditional protection on a non-main exact name
- http/401.json, 403.json, 404.json, 429.json, malformed.txt
- identity/after-drift.json: PR head change after collection starts
