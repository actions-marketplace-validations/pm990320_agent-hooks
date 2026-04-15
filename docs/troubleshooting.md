# Troubleshooting

This doc covers: preflight checks, the venv/PATH problem, skip
directives, agent feedback prompts, and `doctor`.

## Preflight checks

Each step can declare requirements that are checked before running:

```yaml
steps:
  lint:
    run: eslint {files}
    requires:
      - command: eslint
      - path: node_modules/.bin
      - file: .eslintrc.json
      - env: NODE_ENV
      - node-modules: true
    on-missing: warn-skip
```

### `on-missing` behavior

| Context | Default | Rationale |
|---|---|---|
| Git hook (pre-commit, pre-push, …) | `warn-skip` | Never block a commit on infra problems |
| Agent hook (Claude Code PostToolUse) | `warn-skip` | Agent sees warning, keeps going |
| Manual CLI (`agent-hooks run …`) | `fail` | Explicit → explicit failure |
| CI (`agent-hooks ci`) | `fail` | CI must be strict |

Per-step override via `on-missing: warn | warn-skip | skip | fail`.

### What skipped steps look like

Skipped steps appear in the summary table as `SKIPPED (missing: eslint)`
in yellow, not red. Exit code is 0 in hook contexts — commits
proceed.

## Environment resolution

Git hooks run in a subshell that doesn't inherit your interactive
shell setup. Common symptoms: `nvm`-managed Node isn't on PATH,
Python venv isn't activated, `mise`/`asdf` shims aren't loaded,
`direnv`'s `.envrc` hasn't been sourced.

agent-hooks fixes this itself, before any step runs, in order:

1. **direnv** — if `.envrc` exists and `direnv` is installed, merge
   `direnv export json` into the step's env
2. **mise / asdf** — if `.tool-versions` or `.mise.toml` exists,
   merge resolved PATH
3. **Node `node_modules/.bin`** — prepend to PATH when a Node
   package manager is detected
4. **Python venv** — if `.venv/`, `venv/`, or `env/` exists, prepend
   `bin/` to PATH and set `VIRTUAL_ENV`
5. **uv / poetry / pipenv** — prefer `uv run` / `poetry run` /
   `pipenv run` transparently
6. **User-defined** `env:` block in config — wins last

All in one tested place. The `.git/hooks/` shell stubs stay simple.

### Per-step env

```yaml
steps:
  lint:
    run: eslint {files}
    env:
      NODE_ENV: development
      CUSTOM_VAR: value
```

### Global env

```yaml
env:
  PATH: "./scripts/bin:$PATH"
  NODE_ENV: development
```

## Skip directives

Layered escape hatches, most to least specific:

### Commit message tags

- `[skip agent-hooks]` — skip all steps
- `[skip lint]` / `[skip lint,test]` — skip specific
- `[agent-hooks skip]` — alternate syntax
- `[skip ci]` — shared convention, skips everything

### Env vars

- `AGENT_HOOKS_SKIP=1` — skip everything
- `AGENT_HOOKS_SKIP=lint,test` — skip specific
- `AGENT_HOOKS_ONLY=lint` — inverse: run only these

### CLI flags

- `--skip lint,test`
- `--only lint`

### Standard escape hatch

`git commit --no-verify` still works — git itself skips all hook
stubs when that flag is set, ours included. This is the documented
"I know what I'm doing" button.

When a skip fires, agent-hooks still prints what was skipped and
why, so you don't accidentally think the hook ran.

## Agent feedback prompts

After each step, agent-hooks emits a fenced block to stderr that
tells the calling agent what to do next. The fences are stable
sentinels agents can locate without regex guessing:

```
---agent-hooks:next-step---
step: e2e
status: failed
duration: 42.1s
summary: 3 of 27 specs failed
artifacts:
  - test-results/html/index.html
  - test-results/checkpoints/login.spec/
next:
  - Read test-results/html/index.html to see failing specs.
  - Review playwright-checkpoint artifacts…
  - Re-run with: agent-hooks run e2e --files "<paths>"
---end---
```

### When prompts are emitted

| Context | Default |
|---|---|
| Agent context (`--agent`, `AGENT_HOOKS_AGENT=1`, detected agent) | Always |
| Interactive TTY, no agent | Failures only |
| CI | Failures + written to `agent-hooks-report.yml` |
| `--no-prompts` | Never |

### Customizing

```yaml
steps:
  e2e:
    prompts:
      on-success: |
        E2E passed. Review test-results/checkpoints/ for regressions.
      on-failure: |
        E2E failed. See test-results/html/index.html.
```

Template variables: `{step}`, `{duration}`, `{exit_code}`, `{files}`,
`{artifacts}`, `{summary}`.

## `agent-hooks doctor`

```
agent-hooks doctor

✓ Config loaded: .config/agent-hooks.yml
✓ Git hooks wired: pre-commit, pre-push, post-merge
  (stubs at .git/hooks/, managed-hash matches current config)
✓ Environment:
  ✓ direnv: loaded .envrc (3 vars)
  ✓ mise: node@20.11.0, python@3.12.2
  ✓ node_modules/.bin on PATH
  ⚠ Python venv: not detected

Preflight per step:
  ✓ lint         eslint resolved at ./node_modules/.bin/eslint
  ✓ typecheck    tsc resolved at ./node_modules/.bin/tsc
  ⚠ test         vitest NOT FOUND — step will be skipped in hooks
  ✓ build        vite resolved

Agent integrations:
  ✓ claude-code  hooks installed
  ⊘ codex        not detected
  ⊘ cursor       not detected
```

`doctor --fix` offers to resolve what it can (reinstall deps,
create venv, run `mise install`) with confirmation prompts.
