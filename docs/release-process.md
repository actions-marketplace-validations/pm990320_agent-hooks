# Release process

agent-hooks ships as a standalone binary on every tagged release, via
an automated release-please pipeline. This doc describes the pipeline
end-to-end and calls out the one manual step that genuinely cannot be
automated.

## TL;DR

1. Merge conventional-commits PRs to `main`.
2. release-please opens or updates a `chore(main): release x.y.z` PR.
3. Inspect the preview draft release attached to that PR — it has the
   exact binaries that will ship.
4. Merge the release PR → release-please creates a draft real release
   → the promote job copies preview assets onto it → publishes.
5. **First release only:** manually enable the Marketplace listing via
   the GitHub UI on the published release (see below).

## Pipeline architecture

Two workflows own the release story:

- `.github/workflows/ci.yml` — runs on every push and PR. Dogfoods
  `agent-hooks ci` against the repo's own `.config/agent-hooks.yml`.
  No release behavior.
- `.github/workflows/release-please.yml` — runs on every push to
  `main` and on `workflow_dispatch`. Four jobs:
  1. `release-please` — runs `googleapis/release-please-action@v4`
     to create / update the release PR and emit outputs
     (`release_created`, `tag_name`, `pr`, `prs_created`).
  2. `build-preview` — when a release PR exists and is not being
     merged, fans out a 5-target matrix (linux x64/arm64, darwin
     x64/arm64, windows x64) and compiles each binary from the PR
     head branch via `actions/checkout@v4` with
     `ref: fromJson(outputs.pr).headBranchName`. This is the key
     trick that lets us build from the version-bumped commit without
     running a cascading `pull_request` workflow (which GitHub
     suppresses for PRs created by `GITHUB_TOKEN`).
  3. `publish-preview` — downloads the 5 artifacts, reads the
     upcoming version from `.release-please-manifest.json` on the
     PR branch, sed-pins `scripts/install.sh`'s `VERSION="latest"`
     to `VERSION="vX.Y.Z"`, and upserts the floating `preview` draft
     release with all 6 assets (5 binaries + the pinned install.sh).
  4. `promote-release` — runs only when release-please merged a
     release PR and created a real draft release. Downloads every
     asset from the `preview` draft, uploads them to the newly
     created `vX.Y.Z` draft, deletes the preview, publishes the
     real release with `--draft=false --latest`, and advances the
     rolling major tag (`v0`, later `v1`) to point at the new tag
     via the REST API so composite-action consumers pinning
     `pm990320/agent-hooks@v0` get patches without edits.

Everything in jobs 2–3 is redundant if no release PR is open, so they
skip in that case. Job 4 is redundant if release-please didn't create
a release, so it skips in that case.

## Why the preview draft exists

The alternative is to rebuild binaries in the `promote-release` job
after merge. That doubles CI cost, doubles wall-clock release time,
and creates a window where the release tag is visible on GitHub but
the binaries aren't yet. The preview draft means binaries are compiled
**once**, reviewed via the PR, and copied (not rebuilt) to the real
release on merge — atomic publication from the consumer's perspective.

The `preview` tag is reused across versions. Each new release PR push
wipes and recreates the draft, so stale assets never linger.

## Version pinning

- `release-please-config.json` uses `bump-minor-pre-major: true`. Pre-1.0
  `feat:` commits bump patch, `feat!:` bumps minor.
- `release-as: "0.1.0"` pinned the first release. **Remove that field
  after v0.1.0 ships** — leaving it in would pin every subsequent
  release to 0.1.0 too.
- Conventional Commits are enforced by the `commit-msg` git hook via
  commitlint, so release-please can always parse history.

## Rolling major tags

The promote job updates a `v<MAJOR>` tag on every release. For v0.x.y
that's `v0`; once v1.0.0 ships, `v1` also starts rolling. This lets
consumers write:

```yaml
- uses: pm990320/agent-hooks@v0
```

and automatically pick up patch releases. The tag is maintained via
`gh api -X PATCH repos/.../git/refs/tags/v0 -F force=true` so the
pipeline doesn't need a full git history checkout.

## GitHub Marketplace — the one manual step

release-please creates releases via the GitHub REST API. Neither the
REST nor the GraphQL API exposes the "Publish this Action to the
GitHub Marketplace" flag — it's a UI-only toggle on the release edit
page. So the first time we ship, the flow is:

1. Let the pipeline ship v0.1.0 normally.
2. Open the published release on github.com.
3. Click **Edit release**.
4. Check **Publish this Action to the GitHub Marketplace**.
5. Pick a primary and secondary category.
6. Click **Update release**.

After the first listing, subsequent releases may or may not require
the same UI click — GitHub's docs say every release needs it, but in
practice high-velocity actions appear to auto-propagate. If the
Marketplace listing goes stale after a future release, repeat the
steps above.

`action.yml` already has the required `branding:` block (icon +
color), so the Marketplace enable step above should not be blocked on
missing metadata.

## What to do if a release goes sideways

- **Preview draft missing on merge:** `promote-release` will fail
  fast with `::error::No 'preview' draft release found`. Either
  re-run the release-please workflow via `workflow_dispatch` against
  main (which re-runs build-preview + publish-preview) before
  retrying promote, or manually rebuild and attach the assets to the
  created draft release.
- **Binary build flakes on one matrix target:** `fail-fast: true`
  aborts the whole preview rebuild. Re-run the failed jobs from the
  Actions UI.
- **Release tag created but binaries wrong:** `gh release delete
  v0.x.y --cleanup-tag --yes` deletes both the release and the tag,
  then re-run release-please via `workflow_dispatch`.
- **Wrong version shipped:** add a `chore: bump` commit with the
  `Release-As: <desired>` trailer, or a one-off `release-as` field in
  `release-please-config.json`, then push.

## Testing changes to the pipeline locally

You can't. Every moving part (release-please, GitHub Actions, the
`preview` draft release) requires GitHub's side of the pipeline. The
defensive move is to keep the logic small enough to read end-to-end
and fail loudly when assumptions break. Changes to
`.github/workflows/release-please.yml` should be tested by pushing a
no-op `chore:` commit and watching the Actions run; `workflow_dispatch`
is also wired up for on-demand retries without needing a fresh commit.
