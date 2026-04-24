# Monorepo design

This document is the authoritative design note for first-class monorepo
support in `agent-hooks`.

It supersedes the earlier v1 assumption in `PLAN.md` that monorepos would
remain "single config at repo root" only.

## Goals

- Let each service/workspace own its own `agent-hooks` behavior.
- Keep service config paths relative to the service root.
- Let repo-root invocations coordinate work across affected workspaces.
- Let subdirectory invocations still honor a parent root manifest when one
  exists.
- Preserve backwards compatibility for existing single-config repositories.

## Non-goals

- Cross-workspace dependency graphs in the runner.
- Implicit inheritance where root step/pipeline definitions leak into
  workspace configs.
- Auto-generating child workspace configs during `init`.

## Ownership model

### Root config

The root config is required to activate coordinated monorepo mode.

The root config may define:

- `workspaces`
- root-owned `steps`
- root-owned `pipelines`
- root-owned `git` hooks
- root-owned `agents` hooks
- root-owned `env`, `doctor`, `install`, and future top-level settings

The root config acts as:

1. the workspace manifest
2. the root target configuration
3. the coordination policy surface

### Workspace config

Each workspace owns its own full config.

Workspace configs may define their own:

- `steps`
- `pipelines`
- `git` hooks
- `agents` hooks
- `env`
- local overrides

Paths inside a workspace config are interpreted relative to the workspace
root, not the repository root.

### No config inheritance between root and workspace targets

Root and workspace configs are loaded side-by-side, not merged into one big
config tree.

That means:

- a root `lint` step is a root target only
- a workspace `lint` step is a workspace target only
- if both exist, both may run in the same coordinated invocation
- root `env` does not implicitly flow into workspace `env`
- workspace `env` does not implicitly flow into root targets

This keeps ownership clear and prevents root config from accidentally changing
service behavior.

## Activation and discovery

Coordinated monorepo mode activates only when a parent/root config with a
`workspaces:` key is present.

Without that key, `agent-hooks` stays in today's single-config mode.

### Root manifest schema

The root config adds this top-level key:

```yaml
workspaces:
  - services/*
  - packages/*
  - tools/release
```

Each entry is a repo-root-relative explicit path or glob.

A discovered workspace root is expected to contain an `agent-hooks` config in
one of the normal config locations, for example:

- `.config/agent-hooks.yml`
- `.config/agent-hooks.yaml`
- `agent-hooks.yml`
- JSON / JSON5 variants already supported today

### Local overrides

Both root and workspace configs may have local overrides.

Supported layering:

1. root config
2. root local override
3. workspace config
4. workspace local override

The root pair applies only to root-owned targets.
The workspace pair applies only to workspace-owned targets.

There is no cross-layer merge from root into workspace runtime config.

## Proposed config additions

### `workspaces`

Top-level array on the root config only.

```yaml
workspaces:
  - services/*
  - packages/*
```

### `monorepo.run-workspace-selection-default`

Top-level coordination setting on the root config.

```yaml
monorepo:
  run-workspace-selection-default: affected
```

Allowed values:

- `affected` — for `run <target>`, run only workspaces affected by the chosen
  scope (`--files`, `--changed`, `--staged`, `--all`)
- `all` — for `run <target>`, run every workspace that defines that target

This setting affects workspace selection for coordinated `run` invocations.
It does **not** suppress a same-named root target; if the root config defines
that target, the root target still runs as well.

`ci` is different: see below.

## Workspace identity and selectors

Two selector forms are supported:

- `--workspace <selector>`
- `<selector>:<target>`

Examples:

```bash
agent-hooks run lint --workspace serviceA
agent-hooks run lint --workspace services/serviceA
agent-hooks fix serviceA:lint
agent-hooks run services/serviceA:test
```

Selector resolution rules:

1. exact relative-path match wins
2. otherwise, unique basename match wins
3. otherwise, the selector is ambiguous and the command errors

This allows both ergonomic short names and stable explicit paths.

## Overlapping workspace matches

A file path or workspace discovery result may match multiple workspace globs.

Policy:

- choose the **shallowest** matching workspace
- emit a warning
- continue execution

Example:

- `services/*`
- `services/serviceA/packages/*`

A file under `services/serviceA/packages/x` belongs to `services/serviceA` for
routing purposes if both patterns match.

This warning should surface in `doctor` and in the relevant coordinated
invocation output.

## Path semantics

There are two path spaces in monorepo mode:

1. **repo-relative paths** — used for git, change detection, and routing
2. **workspace-relative paths** — used when a workspace target actually runs

Rules:

- git / changed / staged resolution happens against the repository root
- routing partitions repo-relative paths to workspaces
- before running a workspace target, matching files are rebased to
  workspace-relative paths
- workspace commands run with `cwd = <workspace root>`
- root commands run with `cwd = <repo root>`

This preserves the invariant:

> A workspace config behaves exactly as if the workspace root were its own
> standalone repo root.

## Invocation semantics

### From repo root

#### `agent-hooks run <target>`

Coordinated root behavior:

1. if the root config defines `<target>`, run the root target
2. select workspaces using `monorepo.run-workspace-selection-default`
   (`affected` or `all`)
3. among selected workspaces, run only those that define `<target>`
4. silently skip workspaces that do not define `<target>`

`--workspace` and `workspace:target` narrow execution to selected
workspace(s), plus the root target only when that remains semantically valid
for the command.

#### `agent-hooks ci`

`ci` means "what CI would run for the whole monorepo".

So coordinated `ci` behavior is:

1. run the root `ci` target if defined
2. run every workspace `ci` target that exists
3. do this the same way whether invoked from the repo root or a workspace
   subdirectory

`ci` does not use affected-only default routing.

### From a workspace subdirectory

If a parent root config with `workspaces` exists:

- load the parent root
- enter coordinated monorepo mode
- resolve the current workspace from the cwd
- keep the same root-vs-workspace semantics described above

This means a subdirectory invocation does **not** bypass the root manifest.

Examples:

```bash
cd services/serviceA
agent-hooks ci
```

This still runs whole-monorepo `ci`, not just `serviceA`.

For targeted local work, users may opt into `--workspace serviceA` or
`serviceA:<target>`.

## Explicit file lists

Explicit file lists may span multiple workspaces in one invocation.

Example:

```bash
agent-hooks run lint --files services/a/src/x.ts services/b/src/y.ts
```

Behavior:

- route each file to the shallowest matching workspace
- run each affected workspace independently with rebased file paths
- run the root target as well if the root config defines the requested target
  and the command semantics call for it

## Hook semantics

### Git hooks

Repo-root git hook stubs remain the canonical install target.

On hook execution:

1. resolve affected repo-relative files once
2. run root git hook rule(s) if configured
3. partition files to affected workspaces
4. run each affected workspace's own git hook rule(s) independently
5. silently skip workspaces with no rule for that hook

### Agent hooks

Agent hooks follow the same fan-out model:

1. parse the agent payload once
2. run root agent hook rule(s) if configured
3. partition the resulting file set to affected workspaces
4. run each affected workspace's own agent hook rule(s) independently
5. silently skip workspaces with no matching rule

Root and workspace hook rules both run; root rules are not fallbacks only.

## `fix` semantics

`fix` follows the same routing model as `run`.

That means it supports:

- root + workspace coexistence
- `--workspace <selector>`
- `workspace:target`
- workspace-relative execution for workspace-owned fix commands

## `list`, `doctor`, and `install`

### `list`

`list` should group targets by:

- root
- workspace

and make collisions visible without treating them as conflicts.

### `doctor`

`doctor` should validate:

- root/workspace discovery
- missing workspace configs
- overlap warnings
- selector ambiguity
- monorepo activation state
- hook install/hash state across the effective config set

### `install`

Git hook stubs are still installed once at the repo root.

The managed config fingerprint must include the effective monorepo config set,
not just one config file.

That fingerprint should account for:

- root config + local override
- discovered workspace configs + local overrides
- the workspace manifest itself, since it changes routing

## `init`

Monorepo init may stay simple.

Desired behavior:

- ask whether the repo is a monorepo in interactive mode
- provide a clear non-interactive flag for monorepo scaffolding
- scaffold the root config only
- do not generate child workspace configs automatically

## Backwards compatibility

Existing non-monorepo repos keep current behavior unchanged.

Compatibility contract:

- no `workspaces` key => current single-config behavior
- existing config search order stays valid
- existing per-repo hooks/install flow stays valid
- monorepo coordination is opt-in through the root manifest

This keeps migration incremental:

1. add a root config with `workspaces`
2. move service-specific config into service roots
3. keep root-only targets where they still make sense
4. adopt selectors and coordinated hooks as needed

## Migration from a single-config repo

Starting point:

```text
repo/
  .config/agent-hooks.yml
```

Typical migration:

1. Keep the existing root config, add `workspaces:`, and keep any
   genuinely repo-wide targets there
2. Create per-service configs under each workspace root
3. Move service-specific steps/pipelines/hooks into those service configs
4. Rewrite service-owned `files:` globs so they are relative to the
   service root, not the repo root
5. Re-run:
   - `agent-hooks list`
   - `agent-hooks doctor`
   - `agent-hooks ci`
6. Reinstall repo-root git hooks with:

```bash
agent-hooks install
```

### Example

Before:

```yaml
steps:
  lint-api:
    run: bun run lint {files}
    files: services/api/src/**/*.{ts,tsx}
```

After, in `services/api/.config/agent-hooks.yml`:

```yaml
steps:
  lint:
    run: bun run lint {files}
    files: src/**/*.{ts,tsx}
```

The command stayed the same. Only the path semantics changed to become
service-relative.

## Example shape

```text
root/
  .config/agent-hooks.yml
  services/
    serviceA/
      .config/agent-hooks.yml
    serviceB/
      .config/agent-hooks.yml
```

Root:

```yaml
workspaces:
  - services/*

monorepo:
  run-workspace-selection-default: affected

steps:
  lint-root:
    run: bun run lint:root
    invocation: project

pipelines:
  ci:
    steps: [lint-root]
```

Workspace (`services/serviceA/.config/agent-hooks.yml`):

```yaml
steps:
  lint:
    run: bun run lint {files}
    files: src/**/*.{ts,tsx}

pipelines:
  ci:
    steps: [lint]
```

From the repo root:

```bash
agent-hooks ci
```

runs:

- root `ci`
- `serviceA` `ci`
- `serviceB` `ci`

From `services/serviceA/`:

```bash
agent-hooks ci
```

still means the same coordinated whole-monorepo `ci`.
