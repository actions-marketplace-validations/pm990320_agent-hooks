# CLI reference

Every command accepts `--help`. The program itself accepts `--version`.

## Commands

| Command | Purpose |
|---|---|
| [`init`](#init) | Scaffold config + install git hook stubs + agent integrations |
| [`install`](#install) | Re-install git hooks from the current config |
| [`ci`](#ci) | Run the `ci` pipeline — the one thing CI calls |
| [`run`](#run) | Run any pipeline or step with explicit scope |
| [`fix`](#fix) | Run a step's `fix:` command (e.g. `fix lint`) |
| [`list`](#list) | List configured steps and pipelines |
| [`lint` / `test` / `build` / `typecheck` / `format`](#shortcuts) | Shortcuts for `run <name>` |
| [`hook`](#hook) | Canonical agent hook entry point |
| [`agent`](#agent) | Install/list/uninstall agent integrations and skill files |
| [`beads`](#beads) | Beads integration helpers |
| [`doctor`](#doctor) | Validate config, env, preflight, and agent wiring |
| [`schema`](#schema) | Print the JSON schema for `.config/agent-hooks.yml` |

---

### `init`

Scaffold agent-hooks in a repo. Detects stack, generates config,
installs git hooks, optionally creates a GitHub Actions workflow,
optionally wires `postinstall`, optionally installs an agent skill
file.

```
agent-hooks init [--force] [--dry-run]
                 [--template <name>] [--no-templates]
                 [--with-github-actions] [--no-github-actions]
                 [--workflow-name <file>]
                 [--with-postinstall] [--no-postinstall]
                 [--postinstall-mode append|replace|skip]
                 [--with-skill <target>] [--no-skill]
                 [--no-agents-md]
```

- `--force` — overwrite existing files, backing them up to `.bak`
- `--dry-run` — print planned actions without writing anything
- `--template <name>` — force a specific stack detector template,
  bypassing auto-detection (see `docs/stack-detection.md`)
- `--no-templates` — skip detectors entirely and write the minimal
  fallback skeleton
- `--with-github-actions` / `--no-github-actions` — force-on or
  force-off the `.github/workflows/agent-hooks.yml` scaffold
  (default: on iff `.github` already exists)
- `--workflow-name <file>` — override the workflow filename when
  `agent-hooks.yml` would collide with something else
- `--with-postinstall` / `--no-postinstall` — force-on or force-off
  the `package.json` postinstall patch (default: on iff
  `package.json` exists)
- `--postinstall-mode` — how to patch an existing `postinstall`
  script: `append` (default), `replace`, or `skip`
- `--with-skill <target>` — install the agent-hooks skill file for
  the named target (`claude`, `cursor`, `codex`, or `auto` to
  install all three)
- `--no-skill` — explicitly skip the skill install
- `--no-agents-md` — skip the CLAUDE.md / AGENTS.md marker block
  injection (default: auto-detect — inject into every target that
  already exists, never create new files)

On conflict (an existing file differs from what init would write),
init shows a unified diff and prompts `[k]eep / [o]verwrite /
[m]erge / [s]kip`. On non-TTY environments the default is always
`keep`.

### `install`

Re-install git hooks from the current config. Idempotent.

```
agent-hooks install [--if-missing]
```

`--if-missing` is a fast no-op when every expected stub already
exists with a managed-hash header matching the current config.
Designed for use in `package.json` `postinstall` scripts so
`bun install` / `npm install` stays snappy.

### `ci`

Run the `ci` pipeline. This is the single command GitHub Actions
calls. Takes the same flags as [`run`](#run).

```
agent-hooks ci [--jobs <n>] [--force-gates] [--skip <names>]
               [--only <names>]
```

### `run`

Run a pipeline or step with explicit file scope.

```
agent-hooks run <target> [-f|--files <paths...>]
                         [--changed] [--staged] [-a|--all]
                         [--skip <names>] [--only <names>]
                         [-j|--jobs <n>] [--force-gates]
                         [--allow-outside-repo] [--no-prompts]
```

- `<target>` — pipeline or step name. If it's a step, agent-hooks
  synthesizes a one-step pipeline and runs it.
- Scope flags choose the file list: `--files` (explicit) →
  `--all` → `--staged` → `--changed` (default)
- `--skip <names>` / `--only <names>` — comma-separated step names
- `--jobs <n>` — cap parallelism inside a parallel pipeline
- `--force-gates` — bypass `when-changed` gates and run every step
- `--allow-outside-repo` — allow `--files` paths that escape the
  repo root (a footgun; leave off unless you know you need it)
- `--no-prompts` — suppress per-step `agent-hooks:next-step` blocks

### `fix`

Run the step's `fix:` command if defined (see the `fix:` field in
`docs/configuration.md`).

```
agent-hooks fix <step> [-f|--files <paths...>]
                       [--changed] [--staged] [-a|--all]
```

Exits `2` if the step has no `fix:` command defined.

### `list`

Print every step and pipeline from the loaded config, with their
descriptions, tags, and whether a `fix:` command is defined.

```
agent-hooks list
```

### Shortcuts

`agent-hooks lint` / `test` / `build` / `typecheck` / `format` are
sugar for `agent-hooks run <name>` with the same flags as `run`.

### `hook`

Canonical entry point for every agent hook. See
[agent-integration](./agent-integration.md).

```
agent-hooks hook <agent> <hook-name>
agent-hooks hook <agent> --list
```

`--list` enumerates the hook events the handler supports, marks
the ones with rules configured in `agents.<key>.hooks.<event>`,
and prints the matcher + pipeline for each configured rule. It
also warns about configured events the handler doesn't recognize
(typo detection).

### `agent`

```
agent-hooks agent install <name> [--scope project|user]
agent-hooks agent list
agent-hooks agent skill install <target> [--project]
agent-hooks agent skill uninstall <target> [--project]
agent-hooks agent skill list
agent-hooks agent instructions install
agent-hooks agent instructions uninstall
agent-hooks agent instructions list
```

- `agent install <name>` — write the agent's native settings file
  so its hooks call `agent-hooks hook <name> <hook-name>`. Scope
  defaults to `project`.
- `agent list` — list known agents and whether each is detected.
- `agent skill install <target>` — install the agent-hooks skill
  file for `claude`, `cursor`, or `codex`. Defaults to the user
  scope; pass `--project` for repo-local.
- `agent skill uninstall <target>` — remove the installed skill.
- `agent skill list` — show installed skill locations across every
  known target × scope.
- `agent instructions install` — splice the agent-hooks marker
  block into `CLAUDE.md` and/or `AGENTS.md` wherever they already
  exist. Never creates the files. The block body is a constant
  (identical bytes across every project) so the files stay prompt-
  cacheable for coding agents.
- `agent instructions uninstall` — strip the marker block.
- `agent instructions list` — report which files carry the block
  and whether it's in sync with the current agent-hooks version.

### `beads`

```
agent-hooks beads post-sync
```

- `post-sync` — run `bd sync`, then commit any `.beads/*` changes
  with a canonical message. Meant to be invoked from a post-sync
  wrapper; not something you'll usually run by hand.

### `doctor`

Validate config and environment. Checks:

1. Config loads and schema-validates
2. Every pipeline step reference resolves
3. Every step's `requires:` block preflight-evaluates
4. Environment auto-resolution (direnv, mise/asdf, venv,
   `node_modules/.bin`) — lists which layers fired
5. Known agents and whether each is currently installed

```
agent-hooks doctor
```

### `schema`

Print the JSON schema for the config file to stdout.

```
agent-hooks schema > schema.json
```

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENT_HOOKS_SKIP` | Comma-separated step names to skip, or `1`/`true`/`yes`/`all` to skip the whole pipeline |
| `AGENT_HOOKS_ONLY` | Comma-separated whitelist of step names |
| `AGENT_HOOKS_CONTEXT` | Force the prompt context: `agent`, `ci`, or `tty` |
| `AGENT_HOOKS_DEBUG` | When `1`, prints extra diagnostics from the hook dispatcher |
| `AGENT_HOOKS_STDIN_MAX` | Raise the 16 MB cap on hook input bytes |
| `AGENT_HOOKS_FORCE_OUTPUT_MODE` | Force step stdio mode to `inherit` or `buffered` (tests only) |

Commit messages also participate in skip resolution — any of
`[skip ci]`, `[skip agent-hooks]`, or `[skip lint,test]` on
HEAD's last commit will apply. Layering: CLI flags > env vars >
commit-message tags.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | A step failed |
| `2` | Config invalid, unknown target, or usage error |
| `3` | Preflight fatal (step with `on-missing: fail` had unmet `requires:`) |
| `124` | Step hit its `timeout-ms` deadline |
