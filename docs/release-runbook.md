# Release runbook

The commands that are not automated, in the order they need to run.

## One-time cutover (after #33 merges)

```bash
# 1. Protect the branches and tags. Definitions live in .github/rulesets/.
gh api -X POST repos/PotentialHedge/presio/rulesets --input .github/rulesets/main.json
gh api -X POST repos/PotentialHedge/presio/rulesets --input .github/rulesets/tags.json
gh api -X POST repos/PotentialHedge/presio/rulesets --input .github/rulesets/staging.json

# 2. Create the staging branch at the merged main. From here on
#    promote-staging.yml fast-forwards it automatically.
git checkout main && git pull
git push origin main:refs/heads/staging

# 3. Secrets and variables the new workflows need.
#    RELEASE_PLEASE_TOKEN: fine-grained PAT, contents:write + pull-requests:write.
#    The default GITHUB_TOKEN will not do — tags it pushes do not trigger
#    other workflows, so a release tag would land and no image would build.
gh secret set RELEASE_PLEASE_TOKEN
# STAGING_ENV_FILE is optional: deploy-staging.yml defaults to
#   /home/administrator/projects/presio/.env
# which is where the production stack lives. Only set it if that moves.

# 4. Cut the first release. The docs already tell people to pin `:1`, so this
#    should not wait — that tag does not exist until this runs.
gh release create v1.0.0 --title v1.0.0 --generate-notes

# 5. Watch the image build. This is what publishes :latest, :1, :1.0, :1.0.0.
gh run watch "$(gh run list --workflow=publish-local-image.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# 6. Confirm what shipped.
docker run --rm ghcr.io/potentialhedge/presio-local:1 node -e 'console.log(process.env.APP_VERSION)'
gh attestation verify --owner PotentialHedge oci://ghcr.io/potentialhedge/presio-local:1
```

## Every release after that

release-please keeps a `chore(main): release X.Y.Z` PR open, derived from the
conventional-commit messages on `main`. Merging it bumps all three
`package.json` versions, writes `CHANGELOG.md`, and pushes the tag — which
builds and publishes the image. Releasing is that one merge.

## Rolling staging back

`staging` is a pointer at a known-good commit, not a development branch.

```bash
git push -f origin <known-good-sha>:staging
```

That fires `deploy-staging.yml` and redeploys that commit. The next push to
`main` will then fail to promote — deliberately, so a rollback is not silently
undone. Once the fix has landed, promote again on purpose:

```bash
git push -f origin main:staging
```

## Known issue

Builds on the deploy host currently fail at `apk add` — `dl-cdn.alpinelinux.org`
does not resolve from there, while `registry.npmjs.org` does, in the same
build. This affects PR previews and will affect staging deploys; releases build
on GitHub runners and may be unaffected. Previous previews passed because the
`apk` layer was served from the host's build cache. If it does not clear on its
own, moving `deploy/Dockerfile` to `node:20-slim` removes the dependency
entirely — `better-sqlite3` ships glibc prebuilds, so no toolchain and no `apk`
would be needed at all.
