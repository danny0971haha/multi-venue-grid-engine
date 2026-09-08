"""Collector identity and documented API constants."""

VERSION = "2.0.1-independent-corrective"
TOOL_NAME = "protection-collector-v2"
IDENTITY_DISCLAIMER = (
    "Independent new collector. Not a restoration of collect-owner-protection.py, "
    "not the same bytes, and does not inherit any prior tool review."
)

# Current GitHub REST docs at collection-authoring time used this header value.
# Recorded in every request; not a claim that GitHub will keep the same pin.
GITHUB_API_VERSION = "2026-03-10"
ACCEPT = "application/vnd.github+json"

REST_PER_PAGE = 100
GRAPHQL_PAGE_SIZE = 50
MAX_PAGES = 40

SAFE_RESPONSE_HEADER_NAMES = {
    "content-type",
    "date",
    "etag",
    "last-modified",
    "link",
    "retry-after",
    "status",
    "warning",
    "deprecation",
    "sunset",
    "x-accepted-github-permissions",
    "x-accepted-oauth-scopes",
    "x-github-api-version-selected",
    "x-github-media-type",
    "x-github-request-id",
    "x-oauth-scopes",
    "x-poll-interval",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
}

DROP_RESPONSE_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-github-otp",
}

TOKEN_PREFIXES = ("gho_", "ghp_", "github_pat_", "ghu_", "ghr_")

DOCUMENTATION_BASIS = [
    {
        "title": "REST API endpoints for rules",
        "url": "https://docs.github.com/en/rest/repos/rules",
        "notes": (
            "GET /repos/{owner}/{repo}/rulesets with includes_parents (default true), "
            "per_page max 100, page. GET /repos/{owner}/{repo}/rulesets/{id} also "
            "accepts includes_parents. bypass_actors omitted unless the caller has "
            "write access to the ruleset. GET /repos/{owner}/{repo}/rules/branches/{branch} "
            "returns active ruleset rules only; evaluate/disabled are omitted; "
            "classic branch protection is not this endpoint."
        ),
    },
    {
        "title": "REST API endpoints for protected branches",
        "url": "https://docs.github.com/en/rest/branches/branch-protection",
        "notes": (
            "GET /repos/{owner}/{repo}/branches/{branch}/protection. Fine-grained: "
            "Administration repository permissions (read). 404 is not automatically "
            "absence of protection; GitHub may also use 404 when unauthorized. "
            "Message 'Branch not protected' is recorded separately from generic Not Found."
        ),
    },
    {
        "title": "Permissions required for fine-grained personal access tokens",
        "url": "https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens",
        "notes": (
            "GET rulesets and GET rulesets/{id}: Metadata read. "
            "GET rules/branches/{branch}: Metadata read. "
            "GET branches/{branch}/protection: Administration read. "
            "GET org rulesets: Organization Administration write. "
            "GET ruleset history: Administration write."
        ),
    },
    {
        "title": "GraphQL BranchProtectionRule",
        "url": "https://docs.github.com/en/graphql/reference/objects#branchprotectionrule",
        "notes": (
            "Complete classic-protection pattern list via repository.branchProtectionRules "
            "cursor pagination. requiredStatusChecks { context app { databaseId slug name } } "
            "preserves app identity. REST exact-name protection is not a substitute."
        ),
    },
    {
        "title": "Creating rulesets for a repository (fnmatch)",
        "url": "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository",
        "notes": (
            "fnmatch with FNM_PATHNAME: * does not match /. ** crosses directories. "
            "~ALL and ~DEFAULT_BRANCH are documented include tokens."
        ),
    },
    {
        "title": "Using pagination in the REST API",
        "url": "https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api",
        "notes": "Link rel=next/last; per_page max 100.",
    },
]

APPLICABILITY_DOCUMENTATION = {
    "verified_at": "2026-09-09",
    "organization": "https://docs.github.com/en/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization",
    "enterprise": "https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets",
    "fork_exception": "https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/managing-rulesets-for-a-repository",
}
DOCUMENTATION_BASIS.extend([
    {"title": "Live GraphQL schema verification", "url": "https://api.github.com/graphql",
     "verified_at": "2026-09-09", "notes": "Read-only __schema introspection: RateLimit.resetAt; full collector selection validated against returned types/fields/args. Saved with corrective evidence."},
    {"title": "REST permission interpretation", "url": "https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api",
     "verified_at": "2026-09-09", "notes": "Accepted permissions describe endpoint requirements, not caller grants. OAuth scopes alone are not repository authorization."},
    {"title": "Product applicability", "url": APPLICABILITY_DOCUMENTATION["enterprise"],
     "verified_at": "2026-09-09", "notes": "Organization/enterprise rules target repositories in organizations. Personal non-fork ownership must be observed before NOT_APPLICABLE; fork inheritance is not assumed absent."},
])
