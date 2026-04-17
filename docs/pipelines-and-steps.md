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
      files: vitest related {files}
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

## Per-file linting

Most linters accept file paths directly. Use the two-form `run:`
syntax so agent-edit / pre-commit hooks only lint the files that
actually changed, while CI still checks the whole project.

### Linter recipes

**ESLint** (JavaScript / TypeScript):

```yaml
lint:
  run:
    files: eslint {files}
    project: eslint .
  files: "**/*.{ts,tsx,js,jsx,mjs,cjs}"
```

**Biome** (JavaScript / TypeScript / JSON / CSS):

```yaml
lint:
  run:
    files: biome check {files}
    project: biome check .
  files: "**/*.{ts,tsx,js,jsx,json,css}"
```

**Prettier** (formatting check):

```yaml
format-check:
  run:
    files: prettier --check {files}
    project: prettier --check .
  files: "**/*.{ts,tsx,js,jsx,css,json,md}"
```

**Ruff** (Python — already per-file by default):

```yaml
lint:
  run: ruff check {files}
  files: "**/*.py"
```

Ruff is fast enough that per-file vs project makes little
difference, but the `files:` glob still filters the scope to
relevant files.

**Pylint** (Python):

```yaml
lint:
  run:
    files: pylint {files}
    project: pylint src/
  files: "**/*.py"
```

**golangci-lint** (Go):

```yaml
lint:
  run:
    files: golangci-lint run {files}
    project: golangci-lint run ./...
  files: "**/*.go"
```

**Shellcheck:**

```yaml
shellcheck:
  run: shellcheck {files}
  files: "**/*.sh"
  invocation: per-file
  parallel: 8
```

Shellcheck is inherently per-file. `invocation: per-file` + `parallel`
runs up to 8 files concurrently.

### Linters that can't be narrowed

Some tools need the full project context and can't lint one file
in isolation:

- **TypeScript (`tsc --noEmit`)** — needs the full type graph.
  Keep `invocation: project`.
- **Cargo clippy** — works per-crate, not per-file. Keep
  `invocation: project`.
- **mypy** — needs the full program for type inference. Keep
  `invocation: project`.

For these, set `invocation: project` and accept that they run in
full on every hook. They're typically fast enough that the cost is
acceptable (tsc incremental: ~2-5s, clippy incremental: ~1-3s).

## Affected-only testing

Running the full test suite on every agent edit is slow and noisy.
Most test frameworks can filter to only the tests that cover a
given source file. Use the two-form `run:` syntax above to run
affected tests during agent-edit / pre-commit hooks and the full
suite in CI.

**This is the single highest-impact optimization you can make for
agent feedback speed.** A 90-second full vitest suite becomes a
2-second `vitest related src/auth.ts` call when Claude edits one
file.

### Framework recipes

**Vitest** (recommended for Bun / Node projects):

```yaml
test:
  run:
    files: vitest related {files}
    project: vitest run
  files: "**/*.{ts,tsx}"
```

`vitest related` traces the import graph and runs only test files
that transitively import the given source files.

**Jest:**

```yaml
test:
  run:
    files: jest --findRelatedTests {files}
    project: jest
  files: "**/*.{ts,tsx,js,jsx}"
```

`--findRelatedTests` is Jest's equivalent — it uses the module
resolver to find test files that depend on the changed sources.

**Bun test** (no built-in related-test flag):

```yaml
test:
  run: bun test {files}
  files: "**/*.test.{ts,tsx}"
```

Bun's test runner doesn't have a `--related` mode. Passing test
file paths directly works when the agent edits a test file, but
won't catch source-file changes that break a test elsewhere. If
your project uses Bun as the runtime but vitest as the test runner,
prefer the vitest recipe above.

**pytest** (Python):

```yaml
test:
  run:
    files: pytest --testmon {files}
    project: pytest
  files: "**/*.py"
```

`pytest-testmon` (`pip install pytest-testmon`) tracks which tests
cover which source files and re-runs only affected tests. Without
testmon, pytest has no built-in related-file mode — falling back
to `pytest {files}` only works for test files, not source files.

**Go:**

```yaml
test:
  run:
    files: go test {files}
    project: go test ./...
  files: "**/*.go"
```

Go's test runner works per-package. `{files}` here would be
package paths like `./pkg/auth`. For finer granularity, use
`gotestfmt` or `gotestsum` with package-level filtering.

**Cargo (Rust):**

```yaml
test:
  run: cargo test
  invocation: project
```

Cargo doesn't have a per-file related-test mode. Its incremental
compilation makes full `cargo test` fast enough for most projects.

### How it works with agent hooks

When a coding agent edits a file, the `PostToolUse` hook fires
with the edited file paths in the payload. agent-hooks passes
those as the pipeline's file list. Steps with `files:` globs filter
to matching files, and the `run.files` variant is invoked with
`{files}` replaced by the actual paths. Steps without a `files:`
glob or with `invocation: project` run once regardless.

The `when-changed` gate also matches against these payload files,
so a `license-audit` step gated on `package.json` only fires when
the agent actually edited `package.json` — not on every edit.

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
