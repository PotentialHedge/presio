# Rulesets

The branch and tag protection for this repository, kept here so it is
reviewable and reproducible rather than living only in the GitHub UI.

Apply or update one with:

```bash
# create
gh api -X POST repos/PotentialHedge/presio/rulesets --input .github/rulesets/main.json

# update an existing one (find the id with: gh api repos/PotentialHedge/presio/rulesets)
gh api -X PUT repos/PotentialHedge/presio/rulesets/<id> --input .github/rulesets/main.json
```

| File | What it does |
| --- | --- |
| `main.json` | `main` takes changes only through a PR with `tests / client`, `tests / server` and `tests / e2e` green. No force-push, no deletion, linear history. Repository admins can bypass, so a solo maintainer is not locked out during an incident. |
| `tags.json` | `v*` tags cannot be deleted or moved. A release tag that changes underneath someone is the one thing that genuinely breaks downstream self-hosters. |
| `staging.json` | `staging` cannot be deleted. Force-push is deliberately **allowed** — rolling back a staging deploy is `git push -f origin <sha>:staging` (see `.github/workflows/deploy-staging.yml`). |

`main.json` requires no approving reviews: with one maintainer, requiring an
approval means requiring a second account. The gate that matters here is the
test suite, not a rubber-stamp review. Raise
`required_approving_review_count` when there is someone to review.
