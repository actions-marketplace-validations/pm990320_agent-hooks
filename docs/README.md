# agent-hooks documentation

This directory contains the long-form documentation for agent-hooks.
The top-level [`README.md`](../README.md) is for people deciding
whether to try it; this is for people using it.

## Contents

- [Architecture](./architecture.md) — high-level design and how the
  pieces fit together
- [Configuration](./configuration.md) — `.config/agent-hooks.yml`
  schema, every key, every default
- [CLI reference](./cli.md) — every command, flag, and exit code
- [Pipelines and steps](./pipelines-and-steps.md) — the execution
  model, scopes, invocation modes, and parallelism
- [Stack detection](./stack-detection.md) — auto-detected templates
  for bun, npm/pnpm/yarn, uv/poetry, cargo, go, deno, terraform
- [Testing](./testing.md) — area maps for E2E, step tags, and how to
  keep long-running suites out of the fast feedback loop
- [Agent integration](./agent-integration.md) — Claude Code, Codex,
  Cursor, generic, and how the `agent-hooks hook` command dispatches
- [Playwright-Checkpoint](./playwright-checkpoint.md) — first-class
  integration for rich E2E artifacts
- [GitHub Actions](./github-actions.md) — the shipped composite
  action and the workflow scaffold `init` generates
- [Beads](./beads.md) — auto follow-up commits and sync handling
- [Troubleshooting](./troubleshooting.md) — preflight checks,
  environment resolution (venv, direnv, mise), and `doctor`
- [Contributing](./contributing.md) — adding a new agent integration
  or stack detector

## Navigation

Every doc stands alone. Cross-links are marked explicitly. If you
find a section that can't be understood without also reading another
doc, that's a bug — open an issue or send a PR.
