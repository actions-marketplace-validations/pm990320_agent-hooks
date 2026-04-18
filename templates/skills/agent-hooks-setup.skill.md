---
name: agent-hooks-setup
description: Install and configure agent-hooks on a repository — pipeline design, fast feedback patterns, framework-specific recipes. Invoke when setting up CI, pre-commit hooks, or agent feedback loops from scratch.
trigger: user asks to set up agent-hooks, configure CI pipelines, add pre-commit hooks, optimize agent feedback speed, or migrate from another hook tool
---

# agent-hooks setup guide

This skill teaches you how to install agent-hooks on a repository
and configure it for fast feedback loops. Follow these patterns to
get sub-second agent-edit feedback, correct pre-commit hooks, and
reliable CI — all from one config file.

## Installation

Pick one based on the project's runtime:

```bash
# Bun (recommended for Bun projects)
bun add -d @pm990320/agent-hooks

# npm / Node
npm install -D @pm990320/agent-hooks

# Standalone binary (no runtime required)
curl -fsSL https://github.com/pm990320/agent-hooks/releases/latest/download/install.sh | sh
```

Then scaffold the config:

```bash
agent-hooks init
```

`init` auto-detects the stack (bun/npm/pnpm/yarn/uv/poetry/cargo/go/deno),
writes `.config/agent-hooks.yml`, and installs git hook stubs.

## The three pipelines

Every agent-hooks config should define three pipelines with different
goals:

```yaml
pipelines:
  ci:
    # Runs in GitHub Actions on every push/PR.
    # Full, thorough, no shortcuts. Include build + slow steps.
    steps: [lint, typecheck, test, build]

  pre-commit:
    # Runs on `git commit`. Must be fast enough that developers
    # don't bypass it with --no-verify.
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow]

  agent-edit:
    # Runs after every file edit by a coding agent (Claude Code,
    # Codex, etc.). Must be FAST — under 5 seconds ideally.
    # This is the critical feedback loop for agent productivity.
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow]
```

**Key principle:** `agent-edit` and `pre-commit` should be fast.
`ci` should be thorough. Anything slow (builds, E2E tests, license
audits) goes in `ci` only — tag it `[slow]` and the other pipelines
auto-exclude it.

## Fast feedback: the two-form `run:` pattern

The single most important optimization. Most linters and test
runners accept file paths — use the two-form `run:` so agent-edit
only checks the files that just changed:

```yaml
steps:
  lint:
    run:
      files: eslint {files}        # agent-edit: lint ONLY the edited file (~1s)
      project: eslint .            # CI: lint everything (~20s)
    files: "**/*.{ts,tsx,js,jsx}"

  test:
    run:
      files: vitest related {files}  # agent-edit: only affected tests (~2s)
      project: vitest run            # CI: full suite (~90s)
    files: "**/*.{ts,tsx}"
```

`{files}` is replaced with the actual file paths from the hook
payload or `--files` flag. The `project:` variant runs when scope
is `--all` or `invocation: project`.

### Framework recipes

**Vitest** (JS/TS — best affected-test support):
```yaml
test:
  run:
    files: vitest related {files}
    project: vitest run
  files: "**/*.{ts,tsx}"
```

**Jest** (JS/TS):
```yaml
test:
  run:
    files: jest --findRelatedTests {files}
    project: jest
  files: "**/*.{ts,tsx,js,jsx}"
```

**pytest** (Python — needs pytest-testmon for related-test mode):
```yaml
test:
  run:
    files: pytest --testmon {files}
    project: pytest
  files: "**/*.py"
```

**ESLint:**
```yaml
lint:
  run:
    files: eslint {files}
    project: eslint .
  files: "**/*.{ts,tsx,js,jsx,mjs,cjs}"
```

**Biome:**
```yaml
lint:
  run:
    files: biome check {files}
    project: biome check .
  files: "**/*.{ts,tsx,js,jsx,json,css}"
```

**Ruff** (Python):
```yaml
lint:
  run: ruff check {files}
  files: "**/*.py"
```

### Steps that CAN'T be narrowed

Some tools need the full project. Keep them as `invocation: project`:

- **TypeScript (`tsc --noEmit`)** — needs the full type graph
- **mypy** — needs the full program for type inference
- **cargo clippy** — works per-crate, not per-file

These still run on every agent-edit, but they're typically fast
enough with incremental caching (tsc: ~2-5s, clippy: ~1-3s).

## Change gates with `when-changed`

Steps that only need to run when specific files change:

```yaml
license-audit:
  run: bunx license-checker-rseidelsohn --excludePrivatePackages --summary
  invocation: project
  tags: [fast, audit]
  when-changed:
    paths: [package.json, bun.lock]
```

The gate checks whether the pipeline's input files (from the hook
payload, `--files`, `--staged`, or `--all`) match the `paths`
patterns. If not, the step is skipped. No git calls needed — the
gate operates on what's in scope.

## Git hooks

```yaml
git:
  hooks:
    pre-commit:
      pipeline: pre-commit
      # scope: staged         # default for pre-commit
      # scope: changed        # also include unstaged edits
      # scope: all            # full project sweep
    commit-msg:
      pipeline: commit-msg
    post-merge:
      pipeline: reinstall
    post-checkout:
      pipeline: reinstall
    post-rewrite:
      pipeline: reinstall
```

The `scope:` field overrides which files the hook sees:
- `staged` (default for pre-commit) — only `git diff --cached`
- `changed` — files differing from the merge-base
- `all` — every tracked file

`post-merge`/`post-checkout`/`post-rewrite` → `reinstall` pipeline
auto-runs `bun install` (or npm/pnpm equivalent) when the lockfile
changes on branch switches.

## Agent integration

Wire up the coding agent's PostToolUse hook:

```yaml
agents:
  claude-code:
    hooks:
      PostToolUse:
        - matcher: "Write|Edit|MultiEdit"
          pipeline: agent-edit

  codex:
    hooks:
      PostToolUse:
        - matcher: "Bash"
          pipeline: agent-edit
```

Then install the agent's native settings:

```bash
agent-hooks agent install claude    # writes .claude/settings.json
agent-hooks agent install codex     # writes .codex/hooks.json
```

## Commitlint (optional but recommended)

Enforce conventional commits so release-please can parse history:

```bash
bun add -d @commitlint/cli @commitlint/config-conventional
echo '{"extends":["@commitlint/config-conventional"]}' > .commitlintrc.json
```

```yaml
steps:
  commitlint:
    run: bunx commitlint --edit
    invocation: project
    tags: [fast, lint]

pipelines:
  commit-msg:
    steps: [commitlint]

git:
  hooks:
    commit-msg:
      pipeline: commit-msg
```

## Dependency reinstall on branch switch

```yaml
steps:
  install-deps:
    run: bun install
    invocation: project

pipelines:
  reinstall:
    steps: [install-deps]

git:
  hooks:
    post-merge:
      pipeline: reinstall
    post-checkout:
      pipeline: reinstall
    post-rewrite:
      pipeline: reinstall
```

## CI workflow (GitHub Actions)

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - uses: pm990320/agent-hooks@v0
      - run: agent-hooks ci
```

## Verification

After setup, verify everything works:

```bash
agent-hooks doctor        # validates config, hooks, env
agent-hooks list          # shows all steps + pipelines
agent-hooks ci            # runs full CI pipeline locally
```

## Common mistakes to avoid

1. **Running full test suite on agent-edit.** Use `vitest related`
   or `jest --findRelatedTests` — a 90s suite becomes 2s.

2. **Running eslint on the whole project on every edit.** Use
   `eslint {files}` with the two-form `run:` pattern.

3. **Including `build` in agent-edit/pre-commit.** Tag it `[slow]`
   so it only runs in CI.

4. **Not using `when-changed` for license audits.** These are slow
   and only need to run when `package.json` / lockfile changes.

5. **Not setting up `post-merge` reinstall.** Without it, switching
   branches silently leaves stale `node_modules` and everything
   breaks mysteriously.

6. **Using `invocation: project` for linters.** ESLint, Ruff,
   Biome, Prettier all work per-file. Only use `project` for tools
   that genuinely need the full program (tsc, mypy, clippy).
