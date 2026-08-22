# GitHub Bootstrap — One-Time Repository Creation

Target repository name:

`danny0971haha/multi-venue-grid-engine`

This must be a **new independent repository**, not a GitHub fork.

## Preferred method: GitHub CLI

Run from the directory containing this starter pack after authenticating `gh` to the intended GitHub account:

```bash
gh auth status

git init -b main
git add .
git commit -m "docs: bootstrap independent multi-venue grid engine"

gh repo create danny0971haha/multi-venue-grid-engine \
  --public \
  --description "Independent multi-venue perpetual grid engine with fail-closed 100U experiment safety contract" \
  --source . \
  --remote origin \
  --push
```

Then verify:

```bash
gh repo view danny0971haha/multi-venue-grid-engine --json nameWithOwner,isFork,defaultBranchRef,url
```

Expected invariant:

```text
nameWithOwner = danny0971haha/multi-venue-grid-engine
isFork = false
default branch = main
```

## Next step

After the repository exists, create the first implementation branch:

```bash
git checkout -b experiment/v0.1-phase0
git push -u origin experiment/v0.1-phase0
```

Then read `AI_START_HERE.md` and implement **Phase 0 only**.

Do not import or copy `discountry/ritmex-bot` source into this repository.
