# Configuration

agent-hooks reads its config from one of:

1. `.config/agent-hooks.yml` *(recommended — follows the `.config/` convention)*
2. `./agent-hooks.yml`
3. `./.config/agent-hooks.yaml` / `.json` / `.json5`

Local overrides (git-ignored) live in `agent-hooks.local.yml`
alongside the main file and are merged on top.

## Schema

The full shape is validated against a JSON Schema published at
`https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json`.
Reference it at the top of your config for VS Code autocomplete:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json
$schema: https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json
```

You can also dump the current schema locally with:

```
agent-hooks schema > schema.json
```

## Top-level keys

| Key | Type | Purpose |
|---|---|---|
| `name` | string | Project name for display in reports |
| `steps` | map | Named steps — reusable units of work |
| `pipelines` | map | Named pipelines — ordered/parallel groups of steps |
| `git` | object | Git hook installer settings (see below) |
| `beads` | object | Beads integration settings |
| `agents` | map | Per-agent hook → pipeline mapping |
| `env` | map | Extra env vars applied to every step |
| `install` | object | Postinstall wiring preferences (see below) |
| `doctor` | object | Doctor output suppression |

## `install`

Controls how agent-hooks integrates with your package manager's
postinstall hook.

```yaml
install:
  postinstall: auto         # auto | managed | off
```

| Value | Behavior |
|---|---|
| `auto` *(default)* | agent-hooks manages the `postinstall` script. Re-running `init` verifies and updates it if stale. |
| `managed` | agent-hooks set it once; the user has taken ownership since. Don't touch. |
| `off` | Never touch `package.json`. |

When enabled and a Node-family package manager is detected, `init`
adds (or appends to) `package.json`'s `postinstall` script so that
`bun install` / `npm install` on a fresh clone auto-installs git
hooks:

```json
{
  "scripts": {
    "postinstall": "agent-hooks install --if-missing"
  }
}
```

`--if-missing` makes the command a fast no-op when hooks are already
wired — see [cli.md](./cli.md#install).

## Steps

A step is a named command with file-scoping metadata. Example:

```yaml
steps:
  lint:
    run: eslint {files}
    files: "**/*.{ts,tsx,js,jsx}"
    fix: eslint --fix {files}
    invocation: args
    tags: [fast, lint]
    requires:
      - command: eslint
    prompts:
      on-failure: |
        Lint failed on {files}. Run `agent-hooks fix lint` or edit
        directly, then `agent-hooks run lint --files <paths>`.
```

### Step fields

| Field | Type | Default | Description |
|---|---|---|---|
| `run` | string \| object | *required* | Command, or `{ files, project }` variants |
| `files` | glob | — | Filter incoming file lists to this pattern |
| `fix` | string | — | Command form used by `agent-hooks fix <step>` |
| `fallback` | string | — | Command when file list is empty after filter |
| `scope` | `project` \| `files` | `files` | Force the invocation scope |
| `invocation` | enum | `args` | See [pipelines-and-steps](./pipelines-and-steps.md#invocation-modes) |
| `chunk` | number | — | Max files per invocation (mode: `xargs`) |
| `parallel` | number | `1` | Per-file concurrency (mode: `per-file`) |
| `tags` | string[] | `[]` | Tags for pipeline include/exclude filtering |
| `requires` | array | `[]` | Preflight checks — see [Step requires](#step-requires) |
| `on-missing` | enum | context-dependent | What to do when `requires` fails |
| `timeout-ms` | number | `0` | Hard timeout per step invocation (0 = unlimited). On expiry: SIGTERM, then SIGKILL after 1s, exit code 124 |
| `artifacts` | string[] | auto | Paths to surface in the agent feedback prompt |
| `prompts` | object | defaults | `on-success` / `on-failure` templates |
| `env` | map | — | Per-step env vars **merged on top of process.env**. Use this to add or override vars; existing parent env (PATH, HOME, etc.) is always inherited |
| `when-changed` | object | — | Gate the step on a change-path glob + since-ref (see [testing](./testing.md#change-gates)) |
| `areas` | map | — | Logical-area map that rewrites `{files}` when changes touch specific globs (see [Area maps](#area-maps)) |
| `unmatched` | `skip` \| `all` \| `smoke` | `skip` | What to do when no area matched. `skip` → skip the step; `all` → fall through to project variant; `smoke` → use the `smoke` area's `run` selectors. |
| `description` | string | — | Shown in `agent-hooks list` |

### Step env

Step commands always inherit the parent process's environment. The
`env:` field on a step is *merged on top of* `process.env`, so use it
to **add** new vars or **override** existing ones — never to set the
total env. PATH, HOME, and friends are always present.

```yaml
steps:
  build:
    run: bun run build
    env:
      NODE_ENV: production    # overrides any inherited NODE_ENV
      BUNDLE_HASH: ${env.GIT_SHA}
```

Test harnesses that swap `process.env` for an isolated dictionary
should still merge in the parent env if step commands need standard
tools.

### Step requires

Each entry is one of:

| Shape | Meaning |
|---|---|
| `{ command: "<name>" }` | Look for `<name>` on `PATH`. Resolved via every directory in `$PATH`. |
| `{ path: "<rel-or-abs>" }` | Filesystem entry exists (file or directory). Relative paths resolve against the repo cwd. |
| `{ file: "<rel-or-abs>" }` | Same as `path` — kept for readability when you mean a file. |
| `{ env: "<NAME>" }` | Env var `<NAME>` is set to a non-empty value. |
| `{ node-modules: true }` | The repo has a top-level `node_modules/` directory. **Note:** this checks for the directory's existence, not for any specific binary under `node_modules/.bin`. Combine with a `command:` check if you need both. |

When a check fails, the step's `on-missing` policy decides whether to
fail (`fail`), warn but still run (`warn`), warn-and-skip (`warn-skip`),
or silently skip (`skip`). The default is `fail` for manual/CI
invocations and `warn-skip` for git-hook and agent-hook contexts.

### Area maps

An area map lets a step react to changes in one logical area by
running against a *different* set of paths. The classic use case:
"when `schemas/**` changed, re-lint `api/` and `workers/` too."

```yaml
steps:
  lint:
    run: eslint {files}
    files: "**/*.ts"
    areas:
      schemas:
        when: schemas/**
        run: [api/, workers/]
      frontend:
        when: web/**
        run: web/
    unmatched: skip
```

Semantics:

- Each area has a `when` glob (or array of globs) and a `run` target
  (or array of targets). If *any* incoming file matches `when`, the
  area is active.
- The union of `run` values from every matched area replaces the
  `{files}` substitution. The `run` entries are literal selector
  strings, not globs — typically directory paths.
- If no area matches, the `unmatched` policy decides:
  - `skip` (default) — the step is skipped with reason "no areas
    matched"
  - `all` — fall through to the step's project variant
  - `smoke` — use the `smoke` area's `run` selectors; if no `smoke`
    area is defined, this falls back to `skip`

`projectForced` (e.g. `--all`) bypasses area resolution entirely.

## Pipelines

A pipeline is an ordered or parallel group of step names:

```yaml
pipelines:
  ci:
    steps: [lint, typecheck, test, e2e, build]
    parallel: false
  pre-commit:
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow]
    on-excluded: warn
  agent-edit:
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow, browser, e2e]
    on-excluded: silent
```

### Pipeline fields

| Field | Type | Description |
|---|---|---|
| `steps` | string[] | Step names (in order for sequential, any order for parallel) |
| `parallel` | boolean | Run steps concurrently? Default: `false` |
| `exclude-tags` | string[] | Drop steps with any of these tags |
| `include-tags` | string[] | Keep only steps with any of these tags |
| `on-excluded` | `silent` \| `warn` | Whether excluded steps show in output |
| `continue-on-error` | boolean | Run remaining steps on failure? Default: `false` |

## `git`

Maps git hook names to pipelines. agent-hooks installs a shell stub
into `.git/hooks/<name>` for every entry; the stub dispatches to
`agent-hooks hook git <name>`, which runs the named pipeline with the
appropriate file scope.

```yaml
git:
  enabled: auto            # auto | true | false
  hooks:
    pre-commit:
      pipeline: pre-commit
    pre-push:
      pipeline: pre-push
    post-merge:
      pipeline: reinstall
```

| Field | Type | Description |
|---|---|---|
| `enabled` | `auto` \| boolean | Whether to install hooks at all. `auto` installs when `.git/` is present. |
| `hooks.<hook-name>.pipeline` | string | Pipeline to run when this git hook fires. |
| `hooks.<hook-name>.if-missing` | `warn` \| `warn-skip` \| `skip` \| `fail` | Per-hook override of the preflight policy (see [troubleshooting](./troubleshooting.md#preflight-checks)). |

Only client-side hooks are supported (`pre-commit`, `commit-msg`,
`pre-push`, `post-merge`, `post-checkout`, `post-rewrite`, etc.).
Server-side hooks (`pre-receive`, `update`, `post-receive`) are
deliberately rejected by the schema — agent-hooks is a local dev
tool.

## `agents`

Maps each agent's native hook names to pipelines:

```yaml
agents:
  claude-code:
    enabled: auto
    hooks:
      PostToolUse:
        - matcher: "Write|Edit|MultiEdit"
          pipeline: agent-edit
      Stop:
        - pipeline: session-wrap
```

See [agent-integration](./agent-integration.md) for the full list
of hook names per agent.

## Precedence

When the same value is defined in multiple places, later wins:

1. Built-in defaults
2. Stack-detection template fragments
3. `.config/agent-hooks.yml`
4. `agent-hooks.local.yml`
5. Environment variables (`AGENT_HOOKS_*`)
6. CLI flags
