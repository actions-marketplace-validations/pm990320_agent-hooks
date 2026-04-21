# agent-hooks

> One command for CI, pre-commit hooks, and agent feedback loops.

[![CI](https://github.com/pm990320/agent-hooks/actions/workflows/ci.yml/badge.svg)](https://github.com/pm990320/agent-hooks/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pm990320/agent-hooks)](https://www.npmjs.com/package/@pm990320/agent-hooks)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

## What it does

- Replaces per-repo CI glue with `agent-hooks ci` — one command
  that runs in GitHub Actions, locally, and inside git hooks
- Gives coding agents sub-second feedback on file edits instead of
  waiting 3–10 minutes for a GitHub Actions run
- Owns its own git hook installation — no wrapper, no separate tool,
  no generated second config to keep in sync
- Supports service-owned monorepos: root manifest, per-service configs,
  repo-root coordination, and service-relative paths

## Install

**npm** (Node 18+ or Bun):

```bash
# global
npm install -g @pm990320/agent-hooks

# or as a dev dependency
npm install -D @pm990320/agent-hooks
```

**Bun:**

```bash
# global
bun add -g @pm990320/agent-hooks

# or as a dev dependency
bun add -d @pm990320/agent-hooks
```

**Standalone binary** (no runtime required):

```bash
curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh
```

Downloads a single native binary for your OS + arch. No Node or Bun
needed.

<details>
<summary>More install options</summary>

**Pin a version:**

```bash
curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh -s -- --version v0.2.0
```

**Install to a specific directory:**

```bash
curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh -s -- --dir /usr/local/bin
```

**GitHub Action (CI only):**

```yaml
- uses: pm990320/agent-hooks@v0
- run: agent-hooks ci
```

**Manual download:** grab the binary for your OS + arch from the
[latest release](https://github.com/pm990320/agent-hooks/releases/latest).

</details>

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

steps:
  lint:
    run: eslint {files}
    files: "**/*.{ts,tsx}"
  typecheck:
    run: tsc --noEmit
    invocation: project
  test:
    # Two-form run: affected-only tests when an agent edits a file,
    # full suite in CI. This is the single biggest speed win for
    # agent feedback — a 90s full suite becomes a 2s related-test run.
    run:
      files: vitest related {files}
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

See [docs/pipelines-and-steps.md](./docs/pipelines-and-steps.md)
for the full `run:` syntax and recipes for Jest, pytest, Go, and
other test frameworks.

## Monorepos

Use a required root manifest plus service-owned configs:

```text
root/
  .config/agent-hooks.yml
  services/
    service-a/
      .config/agent-hooks.yml
```

Root:

```yaml
workspaces:
  - services/*

monorepo:
  run-workspace-selection-default: affected
```

Service config paths stay relative to the service root. From either the
repo root or a workspace subdirectory:

```bash
agent-hooks ci
```

runs whole-monorepo CI. For targeted runs, use:

```bash
agent-hooks run lint --workspace service-a --files services/service-a/src/a.ts
agent-hooks run services/service-a:lint --changed
```

See [docs/monorepo.md](./docs/monorepo.md) for the ownership model,
selectors, migration notes, and hook fan-out rules.

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
      - uses: pm990320/agent-hooks@v0
      - run: agent-hooks ci
```

## Coding agent integration

agent-hooks ships native hook handlers for 22 coding agents
including Claude Code, Codex, Gemini CLI, GitHub Copilot, Windsurf,
Cline, and more.

```bash
agent-hooks agent install claude    # writes .claude/settings.json
agent-hooks agent install codex     # writes .codex/hooks.json
agent-hooks agent install generic   # prints a shell snippet
```

The pipeline that runs for each hook lives in
`.config/agent-hooks.yml`, not in the agent's settings.

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

**Skipping**: `[skip agent-hooks]` or `[skip ci]` in the commit
message, or `--skip <step>` on the CLI.

**Config location**: `.config/agent-hooks.yml` — JSON-schema
validated. Run `agent-hooks list` to see what steps and pipelines
are defined.

## Documentation

- [Architecture](./docs/architecture.md)
- [Configuration](./docs/configuration.md)
- [Monorepo design](./docs/monorepo.md)
- [CLI reference](./docs/cli.md)
- [Pipelines and steps](./docs/pipelines-and-steps.md)
- [Stack detection](./docs/stack-detection.md)
- [Agent integration](./docs/agent-integration.md)
- [Release process](./docs/release-process.md)
- [GitHub Actions](./docs/github-actions.md)
- [Testing](./docs/testing.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Contributing](./docs/contributing.md)

## License

MIT
