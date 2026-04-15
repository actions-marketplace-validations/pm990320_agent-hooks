# Pipelines and steps

This doc explains the execution model: what a step is, how files
are resolved, how invocation modes work, and how pipelines
compose them.

## Mental model

- **Step**: one command + metadata (file glob, tags, preflight, etc.)
- **Pipeline**: ordered or parallel group of steps
- **Context**: who called agent-hooks (CI / git hook / agent / manual)
- **Scope**: `files` (a filtered list) or `project` (whole repo)

## File resolution

Three contexts produce the file list:

1. **Git hook** — our installed `.git/hooks/<name>` stub dispatches via `agent-hooks hook git <name>`, which computes the right file list for that hook
2. **Agent hook** — the agent's hook handler parses its native input
   and passes files via `--files`
3. **Manual CLI** — agent-hooks shells out to `git diff` for
   `--changed` / `--staged`, or uses `--files`, `--all`, or defaults
   to `--changed`

All three produce the same internal list. It's then filtered through
the step's `files:` glob using `picomatch`.

## Invocation modes

Different tools want file lists in different shapes. Declare the mode
on the step.

### `args` (default)

```yaml
steps:
  lint:
    run: eslint {files}
    invocation: args
```

`{files}` is substituted with the shell-quoted, space-joined list.
Auto-chunked when the command line would exceed `ARG_MAX`.

### `per-file`

```yaml
steps:
  shellcheck:
    run: shellcheck {file}
    files: "**/*.sh"
    invocation: per-file
    parallel: 8
```

Runs once per file, substituting `{file}` (singular). Sequential by
default; `parallel: N` bounds concurrency.

### `stdin`

```yaml
steps:
  custom:
    run: my-linter --from-stdin
    invocation: stdin
```

Files are piped to stdin, one per line.

### `xargs`

```yaml
steps:
  gofmt:
    run: gofmt -l {files}
    invocation: xargs
    chunk: 200
```

Like `args` but with explicit `chunk:` batching.

### `glob`

Re-encodes the file list as the smallest glob the tool accepts.
Substitutes `{glob}`.

### `project`

```yaml
steps:
  typecheck:
    run: tsc --noEmit
    invocation: project
```

Never passes files. Equivalent to `scope: project`.

## Scoped vs project `run:` variants

Some tools need different command lines for file-list vs whole-project
invocations. Use the object form:

```yaml
steps:
  test:
    run:
      files: vitest run --related {files}
      project: vitest run
    files: "**/*.{ts,tsx}"
```

Which variant runs depends on the file list:

| Situation | Variant |
|---|---|
| File list present after filtering | `files` |
| `--all`, `scope: project`, or empty file list with no fallback | `project` |
| Only one variant defined | That one |
| String form | Treated as `files`, also used as `project` if no other variant |

When `project` runs, `{files}` is not substituted.

## Template variables

| Variable | Modes | Value |
|---|---|---|
| `{files}` | `args`, `xargs` | Shell-quoted, space-joined |
| `{file}` | `per-file` | One file at a time |
| `{files_newline}` | any | Newline-joined |
| `{glob}` | `glob` | Minimal glob pattern |
| `{cwd}` | any | Current working dir |
| `{git_root}` | any | Repo root |
| `{env.NAME}` | any | Env var passthrough |

## Symlinks

`git ls-files` reports symlinks as ordinary entries, so they flow
through the file resolver and end up in the step's file list
verbatim. agent-hooks does not filter them and does not follow them
on your behalf — whatever your tool does is what happens:

- **eslint, ruff, prettier**: usually follow the link and lint the
  target. If two symlinks point at the same file you get duplicate
  diagnostics.
- **shellcheck**: follows the link.
- **cargo, go**: resolve through the symlink and apply their own
  rules.

If a step needs different behavior, write the command explicitly:

```yaml
steps:
  lint:
    # `find -L` follows symlinks; `find -P` (default) does not.
    run: find -P {files} -type f -name '*.ts' | xargs eslint
```

We considered filtering symlinks at the resolver level and decided
against it: removing them would silently drop legitimate files for
users who curate symlink trees on purpose, and the per-tool semantics
are too varied to paper over.

## Empty-list behavior

| Mode | Empty list |
|---|---|
| `args`, `stdin`, `xargs`, `per-file` | Skip (exit 0) unless `fallback:` defined |
| `glob` | Run with empty glob (tool decides) |
| `project` | Always runs |

## Pipelines

A pipeline sequences or parallelizes steps.

```yaml
pipelines:
  ci:
    steps: [lint, typecheck, test, build]
  pre-commit:
    steps: [lint, typecheck, test]
    parallel: true
    exclude-tags: [slow]
```

### Parallelism

- `parallel: false` *(default)* — run in order, fail-fast
- `parallel: true` — run concurrently, fail-fast unless `continue-on-error: true`
- Concurrency cap: `min(steps, cpus)` by default, override with `--jobs N`

### Tag filtering

`exclude-tags:` drops steps with any matching tag. `include-tags:`
keeps only steps with any matching tag. `on-excluded: silent | warn`
controls whether excluded steps appear in output.

See [testing](./testing.md) for how this keeps e2e suites out of
fast feedback loops.
