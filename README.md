# agent-hooks

> One command for CI, pre-commit hooks, and agent feedback loops.
> Ships as a single binary. No second tool to configure.

[![CI](https://github.com/pm990320/agent-hooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pm990320/agent-hooks/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> **Status:** early development. The plan and docs describe the
> intended design; the implementation lives in `src/` and is being
> built out milestone by milestone. See [PLAN.md](./PLAN.md).

## What it does

- Replaces per-repo CI glue with `agent-hooks ci` — one command
  that runs in GitHub Actions, locally, and inside git hooks
- Gives coding agents sub-second feedback on file edits instead of
  waiting 3–10 minutes for a GitHub Actions run
- Owns its own git hook installation — no wrapper, no separate tool,
  no generated second config to keep in sync

## Install

```bash
curl -fsSL https://agent-hooks.dev/install.sh | sh
```

That's it. Single standalone binary, no Node/Bun required. Lands at
`~/.local/bin/agent-hooks`.

<details>
<summary>Other install options</summary>

**Pin a version:**

```bash
curl -fsSL https://agent-hooks.dev/install.sh | sh -s -- --version v0.1.0
```

**Install somewhere other than `~/.local/bin`:**

```bash
curl -fsSL https://agent-hooks.dev/install.sh | sh -s -- --dir /usr/local/bin
```

**GitHub Action (CI only, no local install needed):**

```yaml
- uses: pm990320/agent-hooks@v1
- run: agent-hooks ci
```

**Manual download:** grab the binary for your OS + arch from the
[latest release](https://github.com/pm990320/agent-hooks/releases/latest)
and put it on your `PATH`.

</details>

agent-hooks is distributed as a single standalone binary per
platform. It is not published to npm — one artifact, one code path,
no runtime prereqs.

## Quick start

```bash
cd your-repo
agent-hooks init          # scaffolds config + hooks, detects stack
agent-hooks doctor        # sanity check
agent-hooks ci            # run the full pipeline
```

`init` detects your stack (bun / npm / pnpm / yarn / uv / poetry /
cargo / go / deno / terraform / …), writes a starter
`.config/agent-hooks.yml`, and installs shell stubs into
`.git/hooks/<name>` that dispatch back into agent-hooks.

## Your first config

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json
$schema: https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json

steps:
  lint:
    run: eslint {files}
    files: "**/*.{ts,tsx}"
  typecheck:
    run: tsc --noEmit
    invocation: project
  test:
    run:
      files: vitest run --related {files}
      project: vitest run
    files: "**/*.{ts,tsx}"

pipelines:
  ci:
    steps: [lint, typecheck, test]
  pre-commit:
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow]
```

See [docs/configuration.md](./docs/configuration.md) for the full
reference.

## The three contexts

Same config, three entry points.

| Context | Trigger | Scope | Command |
|---|---|---|---|
| CI | GitHub Actions | all files | `agent-hooks ci` |
| Pre-commit | `git commit` | staged files | (automatic via `.git/hooks/` stub) |
| Agent edit | Claude Code PostToolUse | edited files | (automatic via `hook` command) |

## GitHub Actions

```yaml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
      - run: agent-hooks ci
```

## Coding agent integration

**Claude Code**: `agent-hooks agent install claude` writes
`.claude/settings.json` so its hooks call `agent-hooks hook claude
<HookName>`. The pipeline that runs for each hook lives in
`.config/agent-hooks.yml`, not in Claude Code's settings.

**Codex** / **Cursor**: same shape, different agent name.

**Custom agent**: `agent-hooks agent install generic`.

See [docs/agent-integration.md](./docs/agent-integration.md).

## For AI coding agents

If you're a coding agent working in a repo that uses agent-hooks,
these are the commands you need:

| When | Command |
|---|---|
| After editing a file | `agent-hooks run agent-edit --files <paths>` |
| Before committing | `agent-hooks run pre-commit --staged` |
| To verify CI will pass | `agent-hooks ci` |
| To see available steps | `agent-hooks list` |
| To check your environment | `agent-hooks doctor` |

**Passing file paths**: space-separated, quoted if they contain
spaces.

**Skipping**: failing on infra (missing dep, etc.) → already
warn-skipped. Deliberate skip → `[skip agent-hooks]` in the commit
message or `--skip <step>`.

**Beads**: after `bd sync`, run `agent-hooks beads post-sync` to
create the follow-up commit automatically.

**Config location**: `.config/agent-hooks.yml`. JSON-schema
validated — read it to see what steps and pipelines are defined.

## Documentation

- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Pipelines and steps](./docs/pipelines-and-steps.md)
- [Stack detection](./docs/stack-detection.md)
- [Testing (area maps, tags, E2E)](./docs/testing.md)
- [Agent integration](./docs/agent-integration.md)
- [Playwright-Checkpoint](./docs/playwright-checkpoint.md)
- [GitHub Actions](./docs/github-actions.md)
- [Beads](./docs/beads.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Contributing](./docs/contributing.md)

## License

MIT
