# agent-hooks — Implementation Plan

> A unified CI + hook orchestrator for repos that want one command to own
> pre-commit, agent-edit-time checks, and GitHub Actions CI. Designed for
> coding agents (Claude Code, Codex, Cursor, …) to get the same fast
> feedback loop locally that CI gives remotely. Ships as a single binary.

---

## 1. Goals & non-goals

### Goals
- **One command owns CI.** `agent-hooks ci` is the only thing that runs
  in GitHub Actions. Locally or remotely, the result is the same.
- **Fast agent feedback.** After an agent edits a file, a sub-second pipeline
  runs lint/typecheck/test *only on the touched files*, instead of the agent
  waiting 3–10 minutes for a GH Actions run.
- **One config language, one error surface.** A strongly typed YAML config
  defines steps, pipelines, and git-hook-to-pipeline mappings. No generated
  second config, no impedance mismatch with a wrapped tool.
- **Strongly typed DX.** JSON Schema ships with the package, VS Code picks
  it up automatically, autocomplete + validation work out of the box.
- **Single binary distribution** via `bun build --compile --target=…`.
  Cross-compiled for Linux x64/ARM64, macOS x64/ARM64, Windows x64.
- **Native Beads integration.** If `.beads/` exists, auto-wire the
  follow-up-commit dance so agents stop forgetting.
- **Forkable + extensible.** Plugin shape is simple enough to copy-paste.

### Non-goals
- Being a task runner like `just` / `make` / `nx`. Pipelines are flat by design.
- Cross-repo orchestration / monorepo-wide dependency graphs. Start simple.
- Caching. (Maybe later. v1 re-runs steps; correctness > speed for v1.)
- Server-side git hooks (`pre-receive`, `update`, `post-receive`). agent-hooks
  is a local dev tool; server hooks belong in your forge's native config.

### Design decision: no lefthook dependency

Earlier drafts of this plan proposed building on top of lefthook.dev. We
dropped that in favor of owning the git-hook wiring ourselves. The reasons:

1. **We already own the relevant primitives.** File resolution
   (`src/runners/files.ts`), step execution (`src/runners/step.ts`), and
   pipeline orchestration are all ours. Lefthook's core value was that
   machinery — not the hook installer.
2. **Writing `.git/hooks/` stubs is ~200 lines**, not a meaningful
   engineering burden.
3. **Two config languages is a footgun.** Generating `.config/lefthook.yml`
   from our config means every feature needs both a config key AND a
   generated lefthook entry. Every new bug lives in the translation layer.
4. **Binary size.** Vendoring lefthook added ~5 MB × 5 targets. Our binary
   is already large (Bun runtime + deps); we don't need to make it worse.
5. **`--no-verify` still works** because git honors it natively — we
   don't need lefthook to give us the escape hatch.

What we lose: a theoretical `lefthook:` passthrough escape hatch. In
practice, the things users would have wanted to do via that key are better
expressed as first-class agent-hooks steps or `git.hooks.<name>.pipeline`
entries.

---

## 2. Distribution strategy

Distributed **only** as prebuilt standalone binaries. No npm package.

1. **Prebuilt binaries**: built in CI via `bun build --compile`, one per
   target (linux-x64, linux-arm64, darwin-x64, darwin-arm64,
   windows-x64), attached to GitHub Releases.
2. **Install script**: `scripts/install.sh` detects OS + arch, pulls the
   matching asset from the latest (or pinned) GitHub Release, and drops
   it at `~/.local/bin/agent-hooks`.
3. **GitHub Action**: the repo's composite `action.yml` performs the
   same download for CI runners.
4. **Homebrew tap** (later): `brew install agent-hooks/tap/agent-hooks`.

**Why not npm?** We originally considered shipping a dual-channel
(npm package + binaries) distribution, but an npm package either
requires users to already have a JS runtime (defeating the point of
a standalone binary) or reduces to a postinstall shim that downloads
the GitHub Release asset anyway (two code paths, one artifact). We
picked one code path. See `docs/architecture.md` for the rationale.

Binary name: `agent-hooks`. Short alias considered (`ah`) but deferred —
collisions with shell aliases are likely; let users alias if they want.

---

## 2a. Shipped GitHub Action

Alongside the prebuilt binaries, the repo publishes a **reusable
composite GitHub Action** at the repo root (`action.yml`) so
consumers can do:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
        with:
          version: latest        # or pinned: v0.1.2
          config: .config/agent-hooks.yml   # optional override
          pipeline: ci           # which pipeline to run (default: ci)
          cache: true            # cache the downloaded binary across runs
      - run: agent-hooks ci
```

The action:
1. Resolves the requested version (pinned, `latest`, or semver range).
2. Downloads the matching prebuilt binary from the GitHub Release for the
   runner's OS/arch, with GH Actions toolcache for re-use across runs.
3. Adds `agent-hooks` to `PATH`.
4. Optionally runs `agent-hooks ci` itself if `run: true` is set (lets
   short workflows be a single step).
5. Exposes outputs: `version`, `binary-path`, and per-step
   success/failure where parseable.

**Implementation**: Composite action (`action.yml` at repo root), no
JavaScript action wrapper needed — keeps the surface area small and
avoids a separate build pipeline for the action itself. Node shim only
if composite proves limiting.

**Versioning**: tag releases as `v0.1.2` and maintain a rolling `v1` tag
pointing at the latest `v1.x.x` so consumers can pin to a major line.
Release workflow in this repo updates the rolling tag automatically.

**Docs**: `README.md` shows the 5-line workflow snippet above as the
primary onboarding path. `agent-hooks init --with-github-actions`
generates the same snippet locally.

---

## 3. Config file

### 3.1 Location (in priority order)
1. `./.config/agent-hooks.yml`  ← **recommended**, matches the common
   `.config/` convention used by many modern dev tools
2. `./agent-hooks.yml`
3. `./.config/agent-hooks.yaml` / `./.config/agent-hooks.json` / `.json5`
4. `./agent-hooks.config.ts`  *(deferred — adds a bundling step)*

Local overrides (git-ignored): `agent-hooks.local.yml` alongside the main
file, merged on top.

### 3.2 Schema shape (YAML example)

```yaml
# yaml-language-server: $schema=./node_modules/agent-hooks/schema.json
$schema: ./node_modules/agent-hooks/schema.json

name: my-app

# --- Reusable steps ----------------------------------------------------
# A "step" is a named command with optional file-scoping metadata.
steps:
  lint:
    run: eslint {files}
    files: "**/*.{ts,tsx,js,jsx}"
    fix: eslint --fix {files}      # used by `agent-hooks fix lint`
    description: Lint JS/TS sources

  typecheck:
    run: tsc --noEmit
    scope: project                  # doesn't support per-file targeting
    description: TypeScript project check

  test:
    run: vitest run --related {files}
    files: "**/*.{ts,tsx}"
    fallback: vitest run            # used when {files} is empty
    description: Vitest related-to-files

  build:
    run: vite build
    scope: project

# --- Pipelines ---------------------------------------------------------
# A pipeline is an ordered list of step names. Steps inside a pipeline
# run sequentially by default; use `parallel: true` to run concurrently.
pipelines:
  ci:
    steps: [lint, typecheck, test, build]
    parallel: false
  pre-commit:
    steps: [lint, typecheck]
    parallel: true
  agent-edit:        # fast feedback loop after agent writes a file
    steps: [lint, typecheck]
    parallel: true

# --- Git hook wiring ---------------------------------------------------
# Map any git hook name to a pipeline. agent-hooks installs a shell stub
# into .git/hooks/<name> that dispatches to this pipeline. Unlisted hooks
# are not installed.
git:
  enabled: auto            # auto | true | false
  hooks:
    pre-commit:
      pipeline: pre-commit
    pre-push:
      pipeline: pre-push
    post-merge:
      pipeline: reinstall   # e.g. re-run `bun install` when lockfile changed

# --- Beads integration -------------------------------------------------
beads:
  enabled: auto                     # auto | true | false
  pre-commit: stage                 # stage .beads/ changes before commit
  post-sync: commit                 # auto follow-up commit after `bd sync`

# --- Agent integrations ------------------------------------------------
agents:
  claude-code:
    enabled: auto                   # auto-detect .claude/
    hooks:
      PostToolUse:
        - matcher: "Write|Edit|MultiEdit"
          pipeline: agent-edit
  codex:
    enabled: auto
  cursor:
    enabled: auto
```

### 3.3 Schema publishing
- Define config types with **zod** in `src/config/schema.ts`.
- Generate `schema.json` (JSON Schema draft 2020-12) via
  `zod-to-json-schema` at build time.
- Ship `schema.json` at the repo root (committed; regenerated as
  part of `prebuild`).
- Reference it via a stable URL:
  `https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json`.
  `init` writes this into the generated config's `$schema`.
- `agent-hooks schema > schema.json` command dumps it on demand.
- VS Code integration: `init` writes a `.vscode/settings.json` snippet (with
  user confirmation) mapping `agent-hooks.yml` → the schema URL, so
  autocomplete works even without the `$schema` key.

---

## 4. CLI surface

Built with **commander** (per user preference). Each command is a separate
file under `src/commands/` and gets wired into `src/cli.ts`.

| Command | Purpose |
|---|---|
| `agent-hooks init` | Scaffold config + install git hooks + agent integrations. Conflict-aware. |
| `agent-hooks install [--if-missing]` | Re-run git hook + agent integration installation (idempotent). `--if-missing` is a fast no-op when already installed — use in `postinstall` scripts. |
| `agent-hooks ci` | Run the `ci` pipeline. This is the **one thing GH Actions calls**. |
| `agent-hooks run <pipeline\|step> [--files …] [--changed] [--staged] [--all]` | Run any pipeline or single step with explicit scope. |
| `agent-hooks lint [--files …]` | Shortcut for `run lint`. Same for `test`, `build`, `typecheck`, `format`. |
| `agent-hooks fix <step>` | Run the step's `fix:` command if defined. |
| `agent-hooks hook <agent> <hook-name>` | **Canonical entry point for every agent hook.** See §4.5. |
| `agent-hooks hook <agent> --list` | List all hook handlers available for the agent. |
| `agent-hooks agent install <claude\|codex\|cursor\|generic>` | Write the agent's native config so its hooks call `agent-hooks hook <agent> <hook-name>`. |
| `agent-hooks agent list` | Show detected agents and their hook status. |
| `agent-hooks skill install <agent> [--project]` | Install the agent-hooks skill file into the agent's skills directory. See §6.5. |
| `agent-hooks skill uninstall <agent>` | Remove the installed skill. |
| `agent-hooks skill list` | Show installed skill locations and versions. |
| `agent-hooks doctor` | Validate config, check git hook wiring, environment, and agent integrations. |
| `agent-hooks schema` | Print JSON schema to stdout. |
| `agent-hooks list` | List steps and pipelines with descriptions. |
| `agent-hooks version` | Print version info. |

### 4.1 File scope flags (shared across `run`, `lint`, `test`, etc.)
- `--files <glob…>` — explicit list (what agent hooks pass through)
- `--changed` — `git diff --name-only` vs merge-base with default branch
- `--staged` — `git diff --cached --name-only`
- `--all` — ignore scope, run against everything
- Default: **`--staged` if inside a git hook context, else `--changed`**.

### 4.2 Stack detection + starter templates

When `init` runs, it detects the project stack by scanning the repo root
and scaffolds a template config tuned to what it found. Detection is
additive — multiple templates can apply to one repo.

**Detectors** (`src/integrations/detectors/`):

| Detector | Signals | Default steps added |
|---|---|---|
| `bun` | `bun.lockb`, `bunfig.toml`, `package.json` with `packageManager: bun@…` | `lint: bun run lint`, `test: bun test {files}`, `build: bun run build`, `typecheck: bun x tsc --noEmit`, `install: bun install` |
| `node-npm` | `package-lock.json` | same shape via `npm run …` / `npx` |
| `node-pnpm` | `pnpm-lock.yaml` | `pnpm …` variants |
| `node-yarn` | `yarn.lock` | `yarn …` variants |
| `python-uv` | `uv.lock`, `pyproject.toml` | `uv run ruff check {files}`, `uv run pytest`, `uv sync` |
| `python-poetry` | `poetry.lock` | `poetry run …` variants |
| `rust` | `Cargo.toml` | `cargo clippy`, `cargo test`, `cargo build`, `cargo fmt --check` |
| `go` | `go.mod` | `go vet`, `go test ./...`, `go build ./...`, `gofmt -l` |
| `deno` | `deno.json`, `deno.lock` | `deno lint`, `deno test`, `deno check` |
| `terraform` | `*.tf` at root | `terraform fmt -check`, `terraform validate` |

Each detector returns a **template fragment**, not a full config. `init`
merges applicable fragments, deduplicates step names (prefixing with
detector name on collision), and shows the user the merged config
before writing.

**Auto-wired hooks from detectors** (user can opt out):

- **Node/Bun/pnpm/yarn** → `post-merge` hook that runs the matching
  `install` command when `package.json` or the lockfile changed in the
  merged range. Same for `post-checkout` and `post-rewrite`. This kills
  the "pulled main, forgot to reinstall, now tests fail mysteriously"
  class of bug.
- **Python uv/poetry** → same pattern with `uv sync` / `poetry install`.
- **Rust/Go/Deno** → no auto-reinstall (toolchain handles it).

These are added to the `git.hooks` section of the generated
`.config/agent-hooks.yml` and installed as `.git/hooks/<name>` stubs
on the next `agent-hooks install`. Users can see, edit, or delete
them via their normal config — there's no secondary file to discover.

`agent-hooks init --template <name>` forces a specific template and
skips detection. `agent-hooks init --no-templates` starts from an empty
skeleton.

### 4.3 `init` conflict handling
For each file init wants to write:
1. If missing → write it.
2. If present and byte-identical → no-op.
3. If present and different → diff + prompt: `[k]eep / [o]verwrite / [m]erge / [s]kip`.
   - `merge` only offered for YAML/JSON configs where we can semantically merge.
4. `--force` overwrites without prompting. `--dry-run` prints planned actions.

Files `init` touches:
- `.config/agent-hooks.yml` (or user-chosen location)
- `.git/hooks/<name>` (shell stubs that exec back into agent-hooks — see §5.9)
- `.github/workflows/<name>.yml` (optional, see §4.4)
- `.vscode/settings.json` (additive; only adds yaml.schemas mapping)
- `.claude/settings.json`, `.codex/config.json`, … (if agents enabled)

### 4.4 GitHub Actions workflow scaffolding

During `init`, after config is written, prompt:

> Create a GitHub Actions workflow that runs `agent-hooks ci`? [Y/n]

If yes, `init` generates a workflow using our shipped composite action
(§2a). Conflict rules for the workflow file:

1. **Default target**: `.github/workflows/agent-hooks.yml` — a
   dedicated, unambiguous name that avoids clobbering existing `ci.yml`,
   `test.yml`, `build.yml`, etc.
2. **If the user chooses `ci.yml`** (via `--workflow-name ci`): first
   check whether `.github/workflows/ci.yml` exists. If it does:
   - Show a diff preview
   - Offer: `[k]eep existing / [o]verwrite / [r]ename (agent-hooks.yml) / [s]kip`
   - Default is `rename`, never silent overwrite.
3. **Existing `.github/workflows/*` scan**: before writing, scan all
   workflow files for `uses: pm990320/agent-hooks@…` and warn if a
   workflow already wires it up — offer to skip creating a new one.
4. **Flags** (skip the prompt):
   - `--with-github-actions` — generate with defaults, ask only on conflict
   - `--no-github-actions` — skip entirely, don't ask
   - `--workflow-name <name>` — override the target filename
5. **Template** uses the composite action from §2a, pinned to the latest
   `v1` rolling tag, and runs on `push` (default branch) + `pull_request`.
   Includes a commented-out matrix block users can uncomment for
   multi-OS testing.
6. `--dry-run` prints planned actions without writing, same as
   the rest of `init`.

### 4.4a Postinstall wiring (auto-install hooks for teammates)

When a new teammate clones a repo and runs `bun install` / `npm i`,
git hooks should just work. Otherwise they have to remember to run
`agent-hooks install` manually and you end up with the same "I
forgot to install hooks" drift that pre-commit frameworks exist to
solve.

The fix: during `init`, if a Node-like package manager is detected,
offer to add/extend a `postinstall` script in `package.json`:

```json
{
  "scripts": {
    "postinstall": "agent-hooks install --if-missing"
  }
}
```

The `--if-missing` flag makes `agent-hooks install` a no-op when
hooks are already wired correctly, so it adds milliseconds to a
normal `bun install` and doesn't re-run any heavy setup.

**Rules**:

1. **Only offered when a Node-family detector fires** (`bun`,
   `node-npm`, `node-pnpm`, `node-yarn`). Other ecosystems get a
   documented manual path.
2. **Prompted during `init`**, not silent:
   > Wire `agent-hooks install` into `postinstall` so teammates
   > get git hooks automatically when they install deps? [Y/n]
3. **Existing `postinstall` is preserved**. If `package.json`
   already has a `postinstall` script, we offer to append with
   `&&`:
   - Current: `"postinstall": "patch-package"`
   - After:   `"postinstall": "patch-package && agent-hooks install --if-missing"`
   - Prompt diff + `[a]ppend / [r]eplace / [s]kip`.
4. **Package manager aware**: if `packageManager` field is set
   (e.g. `bun@1.2.15`, `pnpm@9.0.0`), we leave it alone. If the
   detector identified pnpm or yarn, the `postinstall` script still
   runs `agent-hooks install` directly — the command is package-
   manager-agnostic.
5. **Agent-hooks must be resolvable**. If `agent-hooks` is not a
   project dependency (yet), we also offer to add it as a
   `devDependency` — otherwise the `postinstall` will fail with
   `command not found` on a fresh clone. Prompt:
   > `agent-hooks` is not in your devDependencies. Add it so
   > `postinstall` can resolve it? [Y/n]
   - If yes: adds it as a dev dep at the current version.
   - If no: writes the `postinstall` anyway with a commented-out
     warning, and doctor later warns about the mismatch.
6. **Flags** (skip the prompt):
   - `--with-postinstall` — add it with defaults
   - `--no-postinstall` — skip entirely
   - `--postinstall-mode <append|replace|skip>` — override the
     conflict behavior
7. **Config key** to record the user's choice so re-running `init`
   doesn't re-prompt:
   ```yaml
   install:
     postinstall: auto          # auto | managed | off
   ```
   - `auto` *(default)* — we manage the script; re-running `init`
     verifies and updates if stale
   - `managed` — we set it once, user took ownership after
   - `off` — don't touch `package.json`

**Non-Node ecosystems**:

- **Python (uv / poetry / pipenv)**: no universal postinstall hook.
  Doctor surfaces a suggestion to add `agent-hooks install` to the
  user's bootstrap command (`Makefile`, `just setup`, etc.) but we
  don't modify config files ourselves.
- **Rust**: `build.rs` runs during `cargo build`, not `cargo add`,
  so it's not a good fit. We suggest a `justfile` / `make` recipe.
- **Go**: no postinstall concept. Same justfile suggestion.
- **Mise / asdf users**: `mise hook-env` / `asdf` integration is a
  future option; out of scope for v0.1.

The rule of thumb: if the ecosystem has a standard "after I install
deps, run X" hook, we offer to wire it. If not, doctor documents the
alternative and we stay out of the user's build files.

**Why `--if-missing` and not unconditional install**:

On a fresh clone, `agent-hooks install` needs to write shell stubs
into `.git/hooks/`, create them with executable perms, and verify
agent integrations. On an existing clone where nothing has changed,
it's a wasted dozen-millisecond no-op. `--if-missing` short-circuits
when every expected `.git/hooks/<name>` stub exists, is marked
executable, and carries a managed-by-agent-hooks header whose embedded
config hash matches the SHA256 of the current agent-hooks config.

The hash comparison is cheap (a single file read + SHA256) and
keeps `bun install` snappy.

### 4.5 `agent-hooks hook <agent> <hook-name>` — canonical agent entry point

Every agent hook — Claude Code's `PostToolUse`, Codex's equivalents,
Cursor's, whatever comes next — goes through a single standardized
CLI shape:

```
agent-hooks hook <agent> <hook-name> [flags]
```

**Why this shape**:

1. **One entry point per agent.** Agent settings files stay
   trivial — they always call `agent-hooks hook claude <name>`, never
   a bespoke `run agent-edit --files "$SOMETHING"` chain.
2. **Hook-to-pipeline mapping lives in agent-hooks config**, not in
   `.claude/settings.json`. Change which pipeline runs on edit? Edit
   `.config/agent-hooks.yml`, don't touch agent settings.
3. **Hook handlers know how to parse their agent's input format.**
   Claude Code passes hook data via stdin JSON; Codex uses env vars;
   Cursor uses something else. The handler does the translation —
   users never think about it.
4. **Hook names match the agent's native names.** If Claude Code
   calls it `PostToolUse`, agent-hooks does too. No translation layer
   for humans to remember. (`PreToolUse`, `PostToolUse`,
   `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`,
   `PreCompact`, etc.)

**What a handler does**:

1. Read agent input from stdin/env/args per that agent's API.
2. Parse it into a normalized internal shape: `{ files, tool, event }`.
3. Look up what the user's `agent-hooks.yml` wants to run for
   `(agent, hook-name)`:
   ```yaml
   agents:
     claude-code:
       hooks:
         PostToolUse:
           - matcher: "Write|Edit|MultiEdit"
             pipeline: agent-edit
           - matcher: "Bash"
             pipeline: post-bash-check
         Stop:
           - pipeline: session-wrap
         UserPromptSubmit:
           - pipeline: preflight
   ```
4. Pick the first matching rule and dispatch to the runner
   (equivalent to `agent-hooks run <pipeline> --files <files>`).
5. Emit the agent-feedback prompt block (§6a) formatted for that
   agent's expected response shape — e.g. for Claude Code's
   PostToolUse, that may be stderr text + a non-zero exit to surface
   the hint, or a structured JSON response depending on the hook.

**Handler code layout**:

```
src/
├── commands/
│   └── hook.ts                       ← dispatches to src/hooks/<agent>/<hook>.ts
└── hooks/
    ├── claude/
    │   ├── index.ts                  ← registry + input parser
    │   ├── pre-tool-use.ts
    │   ├── post-tool-use.ts
    │   ├── user-prompt-submit.ts
    │   ├── stop.ts
    │   ├── subagent-stop.ts
    │   ├── notification.ts
    │   └── pre-compact.ts
    ├── codex/
    │   ├── index.ts
    │   └── …
    ├── cursor/
    │   ├── index.ts
    │   └── …
    └── generic/
        └── index.ts                  ← reads files from flag/env, runs pipeline
```

Each handler is 20–50 lines. Adding support for a new agent is
"implement the registry + one handler per hook you care about" —
deliberately low ceremony so forks and contributors can add agents.

**Input/output contract per agent** is documented in
`src/hooks/<agent>/README.md` inside the repo — which env vars and
stdin shapes are expected, which output format the agent accepts.
This is the single place someone porting to a new agent reads.

**Flags on `hook`** (in addition to agent-specific stdin/env input):

- `--input <path|->` — force reading input from a file or `-` (stdin).
  Useful for testing hook handlers against fixtures.
- `--dry-run` — parse input, resolve rule, print what would run,
  exit 0 without executing.
- `--json` — emit structured output instead of the agent's native
  format (for piping into other tools).

**`agent-hooks hook <agent> --list`** prints:

```
Hooks available for claude:
  PreToolUse          run a pipeline before Claude uses a tool
  PostToolUse         run a pipeline after Claude uses a tool   ← most common
  UserPromptSubmit    run a pipeline when the user submits a prompt
  Stop                run a pipeline when Claude stops responding
  SubagentStop        run a pipeline when a subagent stops
  Notification        handle a notification event
  PreCompact          run a pipeline before conversation compaction

Currently configured (from .config/agent-hooks.yml):
  PostToolUse  matcher="Write|Edit|MultiEdit" → pipeline: agent-edit
  Stop                                        → pipeline: session-wrap
```

---

## 5. Execution model

### 5.1 `agent-hooks ci`
1. Load + validate config.
2. Resolve the `ci` pipeline → ordered list of steps.
3. For each step: compute file list (usually `--all` in CI), run command,
   stream stdout/stderr, capture exit code.
4. Print a summary table: step / duration / status.
5. Exit non-zero on first failure unless `--continue-on-error`.
6. In GitHub Actions, auto-emit `::group::` markers per step and
   `::error file=…,line=…::` annotations when parseable.

### 5.2 File resolution (who computes the file list)

agent-hooks resolves its own file lists from three contexts, all
feeding the same internal pipeline:

1. **Git hook context** — our installed stub in `.git/hooks/<name>`
   dispatches via `agent-hooks hook git <name>`. The hook handler
   computes the appropriate file list for that hook (staged files for
   `pre-commit`, changed files for `pre-push` against the upstream,
   etc.) using `src/runners/files.ts`.
2. **Agent hook context** — Claude Code / Codex / Cursor hand us edited
   file paths via stdin JSON or env. The handler extracts them and
   passes through as the explicit file list.
3. **Manual CLI** (`--changed` / `--staged` / `--all`) — agent-hooks
   shells out to git itself (`git diff --name-only`,
   `git diff --cached --name-only`, `git ls-files`).

All three paths produce the same `{ scope, files }` shape before
filtering through the step's `files:` glob via `picomatch`. One code
path regardless of entry point — no translation layer between a
wrapping tool's file list and ours.

### 5.3 `agent-hooks run <step> --files …`
1. Resolve incoming file list per §5.2.
2. Expand through the step's `files:` glob filter (picomatch).
3. If empty after filtering:
   - if `fallback:` defined → run fallback.
   - else → exit 0 with "no matching files" message.
4. Build the command line per the step's **invocation mode** (§5.4).
5. Exec, stream, return exit code.

### 5.4 Invocation modes (the "standard layer" over CLI calling conventions)

Different tools want file lists in very different shapes. This is the
standard layer so users don't write glue scripts.

Config field on a step: `invocation: <mode>` (default: `args`).

| Mode | Behavior | When to use |
|---|---|---|
| `args` *(default)* | Substitute `{files}` with shell-quoted, space-joined list. Chunked into multiple invocations if the command line would exceed `ARG_MAX` (~128 KB on macOS, ~2 MB on Linux). | `eslint`, `prettier`, `ruff`, most modern tools. |
| `per-file` | Run the command once per file, substituting `{file}` (singular). Files run sequentially by default; `parallel: N` enables bounded concurrency. Exit code is the max of all runs. | Tools that refuse multiple files, legacy linters, `shellcheck` on certain configs. |
| `stdin` | Launch the command once and write each file path on a separate line to stdin, then close stdin. | `xargs`-style tools, custom scripts. |
| `xargs` | Equivalent to `args` with explicit chunk size control (`chunk: <N>` files per invocation). Useful when a tool is slow to start and you want bigger batches. | `clang-format -i`, `gofmt -w`. |
| `glob` | Skip passing files at all; instead re-encode the file list as the smallest glob pattern the tool will accept. `{glob}` substitutes. | Tools that only accept glob args (rare). |
| `project` | Do not pass files at all; run the command once over the whole project regardless of file scope. Equivalent to `scope: project`. | `tsc --noEmit`, `cargo clippy`, `go vet ./...`, `vite build`. |

#### 5.4a Scoped vs project command variants

Real tools need different command lines depending on whether you're
running against a file list or the whole project. `tsc --noEmit` wants
no files; `tsc file.ts --noEmit` needs them. `vitest run` runs the
whole suite; `vitest run --related {files}` runs only related tests.
`eslint .` vs `eslint file1 file2`. Forcing one template to cover both
is how you end up with `{files:-.}` shell hacks.

`run:` therefore supports two forms:

**String form** (single command, `{files}` substituted as usual):
```yaml
steps:
  lint:
    run: eslint {files}
```

**Object form** (explicit scoped vs project variants):
```yaml
steps:
  test:
    run:
      files: vitest run --related {files}    # when a file list is present
      project: vitest run                    # when running project-wide
    files: "**/*.{ts,tsx}"

  typecheck:
    run:
      project: tsc --noEmit                  # only one form — always project-wide
    # no `files:` form → implies scope: project

  eslint:
    run:
      files: eslint {files}
      project: eslint .
    files: "**/*.{ts,tsx,js,jsx}"
```

**Which variant runs**:

| Situation | Variant used |
|---|---|
| File list present after filtering | `files` (falls back to `project` if `files` not defined) |
| `--all` flag passed, or `scope: project`, or file list empty and `fallback` not set | `project` (falls back to `files` with `{files}` empty → may error) |
| Only one variant defined | That one, always |
| String form | Treated as `files` variant; also used for `project` if no other variant defined |

When `project` runs, `{files}` is **not substituted** — the token
simply isn't present in that command line, so there's no chance of a
trailing empty-arg or `""` mishap. Users don't have to defensively
quote or fall back.

**Template variables available in `run:`**:

- `{files}` — shell-quoted, space-joined (modes: `args`, `xargs`)
- `{file}` — single file (mode: `per-file`)
- `{files_newline}` — newline-joined (any mode, rarely needed)
- `{glob}` — minimal glob (mode: `glob`)
- `{cwd}`, `{git_root}` — contextual paths
- `{env.NAME}` — env var passthrough

**Empty-list behavior** is per-mode:

- `args` / `stdin` / `xargs` → skip invocation entirely (exit 0)
- `per-file` → skip invocation entirely (exit 0)
- `project` → always runs, ignores file list
- `glob` → runs with empty glob (tool's choice)

Unless the step defines `fallback:`, in which case the fallback runs on
empty-list in any file-scoped mode.

**Escaping**: file paths are always quoted with each mode's correct
rules — shell-escape for `args`/`xargs`, raw for `stdin`, single-file
shell-escape for `per-file`. Users never write quoting logic themselves.

**Example configs**:

```yaml
steps:
  eslint:
    run: eslint {files}
    files: "**/*.{ts,tsx,js,jsx}"
    invocation: args           # default, shown for clarity

  prettier-check:
    run: prettier --check {files}
    files: "**/*.{ts,tsx,md,yml}"

  shellcheck:
    run: shellcheck {file}
    files: "**/*.sh"
    invocation: per-file       # shellcheck is happier one-at-a-time
    parallel: 8

  gofmt:
    run: gofmt -l {files}
    files: "**/*.go"
    invocation: xargs
    chunk: 200

  tsc:
    run: tsc --noEmit
    invocation: project        # never cares about file list

  custom-stdin-tool:
    run: my-linter --from-stdin
    files: "src/**/*.ts"
    invocation: stdin
```

This is the bit that makes agent-edit hooks *actually* fast: lint runs
against 2 touched files, not 200 — and the user didn't have to write a
bash wrapper to make it happen.

### 5.5 Parallelism
- Pipeline-level `parallel: true` → run all steps concurrently, fail-fast
  unless `--continue-on-error`.
- Concurrency cap: `min(steps, os.cpus())` by default, override with `--jobs N`.

### 5.6 Resilient hooks: preflight, skipping, and environment

This is a first-class concern, not a nice-to-have. The fastest way to
teach developers to reach for `git commit --no-verify` is to block their
commit because `eslint` wasn't on PATH in the git hook's subshell. We
want the opposite: warn loudly, don't block.

#### 5.6.1 Preflight checks (per-step `requires:`)

Each step can declare requirements that are checked before execution:

```yaml
steps:
  lint:
    run: eslint {files}
    requires:
      - command: eslint             # checks executable is resolvable
      - path: node_modules/.bin     # checks path exists
      - file: .eslintrc.json        # checks file exists
      - env: NODE_ENV               # checks env var is set
      - node-modules: true          # shortcut: node_modules/ exists + lockfile fresh
    on-missing: warn-skip           # warn | warn-skip | skip | fail
```

`on-missing` behavior (and defaults by context):

| Context | Default | Rationale |
|---|---|---|
| Git hook (pre-commit, pre-push, …) | `warn-skip` | Never block a commit on infra problems. |
| Agent hook (Claude Code PostToolUse) | `warn-skip` | Agent should see the warning, keep going. |
| Manual CLI (`agent-hooks run …`) | `fail` | Explicit invocation → explicit failure. |
| CI (`agent-hooks ci`) | `fail` | CI must be strict. |

The defaults are per-context and **overridable per-step**. Users who want
their pre-commit hook to hard-fail when deps are missing can set
`on-missing: fail`. Users who want CI to tolerate missing optional tools
can set `on-missing: warn-skip`.

When a step is skipped due to preflight failure, the summary table
shows `SKIPPED (missing: eslint)` in yellow, not red. Exit code is 0
in hook contexts, matching the spirit of "warn but let the commit
through."

#### 5.6.2 Skip directives

Multiple ways to skip, from most to least specific:

1. **Commit message tags** (checked for pre-commit/commit-msg/pre-push):
   - `[skip agent-hooks]` — skip all steps
   - `[skip lint]`, `[skip lint,test]` — skip specific steps
   - `[agent-hooks skip]` — alternate syntax
   - `[skip ci]` — shared with common conventions, skips everything

2. **Env vars**:
   - `AGENT_HOOKS_SKIP=1` — skip everything
   - `AGENT_HOOKS_SKIP=lint,test` — skip specific steps
   - `AGENT_HOOKS_ONLY=lint` — inverse: run only these

3. **CLI flag**: `--skip lint,test` / `--only lint`

4. **Standard escape hatch**: `git commit --no-verify` still works
   because git itself honors it — it simply skips all `.git/hooks/*`
   stubs, ours included. Documented as the "I know what I'm doing,
   just get out of my way" button.

When a skip directive fires, we still print what was skipped and why,
so users don't accidentally think the hook ran.

#### 5.6.3 Environment resolution (the venv / PATH problem)

Git hooks execute in a subshell that doesn't inherit the user's
interactive shell setup. Common pain points: `nvm`-managed Node isn't
on PATH, Python venv isn't activated, `mise`/`asdf` shims aren't
loaded, `direnv`'s `.envrc` hasn't been sourced.

Agent-hooks fixes this **before** running any step, in this order:

1. **direnv** — if `.envrc` exists and `direnv` is installed, run
   `direnv export json` and merge the result into our env. This is the
   single biggest win for repos that already use direnv.
2. **mise / asdf** — if `.tool-versions` or `.mise.toml` exists, shell
   out to `mise env --json` / `asdf env` to get the resolved PATH and
   merge.
3. **Node `node_modules/.bin`** — if a Node package manager is
   detected, prepend `./node_modules/.bin` to PATH. Covers the common
   case without needing a package manager prefix.
4. **Python venv** — look for `.venv/`, `venv/`, `env/` in repo root.
   If present, prepend the venv's `bin/` to PATH and set
   `VIRTUAL_ENV`. Equivalent to `source .venv/bin/activate`.
5. **uv / poetry / pipenv** — if detected, prefer running commands
   via `uv run` / `poetry run` / `pipenv run` transparently. This is
   opt-in per-step via `env: uv` / `env: poetry`, or automatic when
   the detector template is used (§4.2).
6. **User-defined env** — the config can declare:
   ```yaml
   env:
     PATH: "./scripts/bin:$PATH"
     NODE_ENV: development
   ```
   merged last so users always win.

All of this happens in-process in agent-hooks, **not** in the
`.git/hooks/` shell stubs. The stubs stay simple
(`exec agent-hooks hook git <name> "$@"`) and the env discovery
logic lives in one tested place.

#### 5.6.4 `agent-hooks doctor`

Ties the above together. Output is a checklist:

```
agent-hooks doctor

✓ Config loaded: .config/agent-hooks.yml
✓ Git hooks wired: pre-commit, pre-push, post-merge
  (stubs at .git/hooks/, managed-hash matches current config)
✓ Environment:
  ✓ direnv: loaded .envrc (3 vars)
  ✓ mise: node@20.11.0, python@3.12.2
  ✓ node_modules/.bin on PATH
  ⚠ Python venv: not detected (no .venv/ found)
  
Preflight per step:
  ✓ lint         eslint resolved at ./node_modules/.bin/eslint
  ✓ typecheck    tsc resolved at ./node_modules/.bin/tsc
  ⚠ test         vitest NOT FOUND — step will be skipped in hooks
  ✓ build        vite resolved at ./node_modules/.bin/vite

Agent integrations:
  ✓ claude-code  hooks installed in .claude/settings.json
  ⊘ codex        not detected
  ⊘ cursor       not detected
```

`doctor --fix` offers to resolve what it can (reinstall deps, create
venv, run `mise install`, etc.) with confirmation prompts.

### 5.6a Change-gated steps ("only when deps changed")

Some checks only need to run when a specific class of file changes.
License auditing on npm dependencies, security scanning on the
dependency tree, schema generation when a model file changes,
regenerating a lockfile… running these on every commit is wasteful,
but not running them until CI means the agent installs a new dep
with an AGPL license and doesn't find out for 10 minutes.

The fix: **change gates**. A step can declare a list of watch paths,
and it runs only when at least one matching file has changed since a
reference point.

```yaml
steps:
  license-audit:
    run: ./scripts/check-licenses.sh
    invocation: project
    when-changed:
      paths:
        - "package.json"
        - "package-lock.json"
        - "pnpm-lock.yaml"
        - "bun.lockb"
      since: last-run        # last-run | merge-base | head

  dep-security:
    run: ./scripts/audit-deps.sh
    invocation: project
    when-changed:
      paths:
        - "package.json"
        - "bun.lockb"
      since: merge-base

  python-reqs:
    run: uv sync
    invocation: project
    when-changed:
      paths: ["pyproject.toml", "uv.lock"]
      since: head              # only after a fresh edit
```

#### `since` values

| Value | Meaning | Best for |
|---|---|---|
| `head` | Diff of staged + unstaged vs current HEAD. Fires whenever the file differs from the committed version in *this* working copy. | Agent-edit hooks — catches an agent that just edited `package.json`, before anything is committed. |
| `merge-base` | Diff vs merge-base with default branch. Fires if the file changed on this branch. | pre-push, CI — catches anything introduced since diverging from main. |
| `last-run` | Diff vs the last time this specific step ran successfully. Requires cache in `.agent-hooks/state/`. | Expensive audits you want to run at most once per change — even if a branch already-checked keeps growing. |

`last-run` uses a per-step cache file (`<.agent-hooks/state/<step>.hash`)
containing the SHA256 of the concatenated watch-path contents at last
successful run. On the next invocation we compute the current hash
and skip the step if it matches. This file is gitignored by default.

#### Semantics

1. When a step runs, check `when-changed.paths` for matches.
2. If no path has changed per the `since` strategy → mark the step
   **skipped-by-gate** and exit 0 for the step (the pipeline
   continues).
3. If something has changed → run the step normally. On success,
   update the `last-run` hash if applicable.
4. The `--all` flag forces all change-gated steps to run regardless
   (useful for CI + manual "rerun everything" invocations).
5. The `--force-gates` CLI flag does the same for a single run
   without needing `--all`.

#### Interaction with other features

- **Tag filtering**: change-gates are evaluated *after* tag filters,
  so an excluded step never checks its gate.
- **Area maps**: a step can have both. Change-gates decide whether
  the step runs at all; area maps decide which files `{files}` gets
  substituted with.
- **Agent feedback prompts**: a step skipped by a gate still emits
  a prompt line ("skipped — deps unchanged since merge-base") so
  agents see what happened.

#### Why this matters for agents

The killer use case is the inline feedback loop. An agent installs
`some-new-package`, runs `agent-hooks run agent-edit`, and gets an
**immediate** license check + security scan because the agent-edit
pipeline includes change-gated `license-audit` and `dep-security`
steps. If the package has a problem, the agent knows within seconds,
not after a 10-minute CI run. No rabbit hole.

Without change-gating, the same agent run would need to execute
those expensive scans every time — slow enough that they'd get
excluded from agent-edit, which defeats the point.

#### Rollout

- **v0.1**: `since: head` and `since: merge-base` only. These are
  pure `git diff` queries, no cache needed.
- **v0.2**: `since: last-run` with the `.agent-hooks/state/` cache.
  Adds the invalidation edge cases (what if the cache is stale after
  a branch switch?) but unlocks the most powerful use case.

### 5.7 Targeted test selection ("area maps" for E2E)

E2E tests are where naïve "run everything that imports this file"
strategies collapse. A change to `src/auth/login.ts` probably only
needs the login + signup E2E specs, not the full suite. But asking app
developers to write dependency graphs by hand is exactly the kind of
custom-scripting burden we're trying to eliminate.

The middle path: **declarative area maps**, opt-in, simple.

```yaml
steps:
  e2e:
    run:
      files: playwright test {files}
      project: playwright test
    files: "e2e/**/*.spec.ts"
    # Area map: when source files match a pattern, run the listed specs.
    areas:
      auth:
        when: "src/auth/**"
        run: "e2e/auth/**/*.spec.ts"
      checkout:
        when: "src/checkout/**"
        run:
          - "e2e/checkout/**/*.spec.ts"
          - "e2e/payment/**/*.spec.ts"
      shell:
        when: ["src/layout/**", "src/nav/**", "app.tsx"]
        run: "e2e/smoke/**/*.spec.ts"
    # What to do when changed files don't match any area
    unmatched: skip     # skip | all | smoke
```

**Semantics**:

1. When the step runs with a file list, agent-hooks intersects the
   list against each area's `when:` glob(s). For every area that
   matches, its `run:` specs are added to the target set.
2. The target set is deduplicated, then substituted for `{files}` in
   the step's `run.files` command.
3. If no areas match, behavior is controlled by `unmatched:`:
   - `skip` *(default)* — don't run the step at all, print
     "no areas matched" in yellow
   - `all` — run the full suite (`run.project` form)
   - `smoke` — run the step's configured smoke subset (if defined via
     a reserved `smoke:` area) — the fast safety net
4. The scope stays intentionally simple: no dependency graphs, no
   `import` tracking, no AST parsing. Just globs. If users need more,
   they write their own step with `scope: project`.

**Why this works for agents**: after editing `src/auth/login.ts`, an
agent running `agent-hooks run e2e --changed` automatically runs
`e2e/auth/**` — maybe 8 specs in 40s — instead of the full 200-spec
run in 15 minutes. The app developer wrote ~6 lines of YAML, not a
dependency tracker.

**Not trying to solve**: transitive import analysis, cross-component
coupling, data-driven fixtures. Those are v2 problems. The 80% case
is "changes in area X need E2E coverage for area X."

### 5.8 Tagged steps and short-hook policy (E2E in fast loops)

E2E / Playwright / Cypress / Cucumber / integration tests should
**never** run in pre-commit or agent-edit pipelines by default. They
take too long and hammer the feedback loop. But they *should* run in
CI, in pre-push (sometimes), and on explicit `agent-hooks run e2e`.

This is handled via step **tags**:

```yaml
steps:
  e2e:
    run: playwright test
    tags: [slow, e2e, browser]
  integration:
    run: vitest run integration/
    tags: [slow, integration]
  test:
    run: vitest run {files}
    tags: [fast, unit]
```

Pipelines declare which tags they accept:

```yaml
pipelines:
  ci:
    steps: [lint, typecheck, test, e2e, build]   # explicit — runs everything
  pre-commit:
    steps: [lint, typecheck, test]
    exclude-tags: [slow]        # belt and braces — also filter
  agent-edit:
    steps: [lint, typecheck, test]
    exclude-tags: [slow, browser, e2e]
    on-excluded: silent         # silent | warn
```

**`on-excluded` behavior**:

- `silent` *(default for agent-edit)* — excluded steps don't appear
  in output at all; agents see a fast, clean pipeline
- `warn` *(default for pre-commit)* — excluded steps appear in the
  summary as `SKIPPED (tag: slow)` so developers remember the fuller
  suite exists

**Good defaults from stack detection** (§4.2): when a Playwright /
Cypress / Cucumber / Selenium / webdriverio / detox config is
detected during `init`, the generated template:

1. Scaffolds an `e2e` step with `tags: [slow, e2e, browser]`
2. Adds `exclude-tags: [slow]` to `pre-commit` and `agent-edit`
3. Includes `e2e` in `ci` explicitly
4. Adds a commented-out `pre-push` pipeline that includes `e2e` for
   users who want e2e-before-push safety

So out of the box, the agent never waits on a 5-minute Playwright run
during a file edit, but CI still runs it.

**Doctor surfaces this** (§5.6.4 extension):

```
Long-running test categories detected:
  ✓ playwright   tagged [slow, e2e, browser]
                 excluded from: pre-commit, agent-edit
                 included in:   ci
  ⚠ cypress      detected in cypress.config.ts but no step references it
                 → run `agent-hooks init --add-step cypress` to scaffold
```

The warning when detected-but-not-configured is the key bit: it
catches the common case where someone adds Playwright later and
forgets to wire it into agent-hooks.

### 5.9 Git hook installer

Instead of wrapping another tool, agent-hooks writes shell stubs
directly into `.git/hooks/<name>` from `src/integrations/git/install.ts`.

**What a stub looks like**:

```sh
#!/bin/sh
# agent-hooks managed hook — do not edit
# config-hash: <sha256 of .config/agent-hooks.yml>
# generated-at: <ISO-8601 timestamp>
exec agent-hooks hook git pre-commit "$@"
```

**Install algorithm**:

1. Load config, compute its SHA256 as `managed-hash`.
2. For every entry in `git.hooks` whose pipeline exists:
   - If the target `.git/hooks/<name>` is missing → write stub, `chmod +x`.
   - If it exists and carries our header → if the hash matches, leave it
     alone; if it doesn't, rewrite (user is upgrading agent-hooks or
     changed their config).
   - If it exists and does **not** carry our header → it's a
     user-managed hook. Behavior is prompt-driven at `init` (append, wrap,
     rename, skip) and never clobbered at `install --if-missing`.
3. For every installed hook that's no longer in `git.hooks` → remove it
   (only if it still carries our header; never touch user-managed stubs).

**Why shell stubs, not JS or Bun scripts**: git hooks run in a
minimal environment. `sh` is guaranteed to exist on every platform
git supports. The stub does nothing but exec agent-hooks — env
discovery, file resolution, everything else happens in our binary.

**Windows**: git for Windows ships Git Bash, which provides `sh`, so
the same stubs work. For users on native Windows tooling without Git
Bash, we emit `.cmd` wrappers alongside the POSIX stubs.

**`agent-hooks install` vs `agent-hooks install --if-missing`**:

- Plain `install` always re-writes every stub (useful when you've
  just edited `.config/agent-hooks.yml`).
- `--if-missing` short-circuits when all stubs exist and their
  `config-hash` matches the current config SHA. Designed for use in
  `package.json` postinstall — adds milliseconds, not seconds.

**User-managed hooks coexistence**: if someone already has
`.git/hooks/pre-commit` from another tool, `init` offers to append
the agent-hooks call at the end (chained), replace it entirely
(archiving the original), or skip the hook altogether. Never silent
clobber.

---

## 6. Agent integrations

Two concerns, cleanly split:

- **Installers** (this section) — write the agent's native settings
  file so its hooks *call* `agent-hooks hook <agent> <hook-name>`.
- **Handlers** (§4.5) — implement what happens when that CLI is
  invoked. Parse the agent's input, look up the rule in
  `agents.<name>.hooks` config, dispatch to the runner.

Each integration lives in `src/integrations/agents/<name>/` and
implements:

```ts
interface AgentIntegration {
  name: string;
  detect(cwd: string): Promise<boolean>;
  install(config: Config, cwd: string): Promise<InstallResult>;
  uninstall(cwd: string): Promise<void>;
}
```

### 6.1 Claude Code
- Detects `.claude/` directory.
- Writes `.claude/settings.json` hooks block so each configured event
  calls `agent-hooks hook claude <HookName>`. Claude Code passes
  hook data on stdin as JSON — the handler (§4.5) parses it.
- Example generated block:
  ```json
  {
    "hooks": {
      "PostToolUse": [
        { "matcher": "Write|Edit|MultiEdit",
          "hooks": [{ "type": "command", "command": "agent-hooks hook claude PostToolUse" }] }
      ],
      "Stop": [
        { "hooks": [{ "type": "command", "command": "agent-hooks hook claude Stop" }] }
      ]
    }
  }
  ```
- Merges with existing hooks rather than overwriting. If an
  `agent-hooks hook claude …` entry already exists for a given event,
  it's left alone.

### 6.2 Codex
- Detects `.codex/` or `codex.toml`.
- Writes Codex config so its hooks call `agent-hooks hook codex <HookName>`.
- Hook handler translates Codex's env/arg shape into the normalized
  internal form. (Exact Codex hook API is tracked as a TODO — the
  abstraction is what matters.)

### 6.3 Cursor
- Detects `.cursor/`.
- Writes Cursor config so its hooks call `agent-hooks hook cursor <HookName>`.

### 6.4 Generic
- `agent-hooks agent install generic` prints a shell snippet any agent
  can wire in. The snippet calls `agent-hooks hook generic edit`,
  reading file paths from stdin, a file, or a flag — the generic
  handler accepts all three.

### 6.5 Agent skill file (installable reference)

agent-hooks ships a reusable **skill file** — a single markdown file
agents can install into their native skills directory — that teaches
an agent everything it needs to know to work with an agent-hooks
repo without having to re-read docs from scratch.

**Why**: the "For AI coding agents" README section (§13.3) is
useful but only if the agent happens to read the README. A proper
skill file is *discoverable* — it lives in the agent's skills
registry (`~/.claude/skills/`, Cursor equivalents, etc.) and the
agent surfaces it automatically when the user's task matches the
skill's trigger description.

**What it contains** — the skill is a complete operator manual for
agents, not an overview for humans:

- When to invoke which pipeline (`agent-edit` after edits,
  `pre-commit` before commits, `ci` before claiming "done")
- How to read the fenced `---agent-hooks:next-step---` prompt block
- How to pass file lists via `--files`
- How to interpret `SKIPPED (missing: …)` and `SKIPPED (tag: slow)`
  without panicking
- How to add a step to `.config/agent-hooks.yml` when the user asks
  for one — the minimum viable step, with the right invocation mode
- How to add a pipeline and wire it to an agent hook
- How to call `agent-hooks beads post-sync` after `bd sync`
- How to detect and review Playwright-Checkpoint artifacts after e2e
- The skip directives (`[skip agent-hooks]`, `--skip`, `--no-verify`)
  and when each is appropriate
- The `agent-hooks doctor` command and what its output means

**Where it lives in the package**:

```
templates/
└── skills/
    ├── agent-hooks.skill.md          ← canonical skill file
    └── agent-hooks.skill.meta.yml    ← frontmatter for the skill
```

**Installation via agent-hooks**:

```
agent-hooks skill install claude           # ~/.claude/skills/
agent-hooks skill install cursor           # cursor equivalent
agent-hooks skill install codex            # codex equivalent
agent-hooks skill install --project claude # repo-local, not user-global
agent-hooks skill uninstall claude
agent-hooks skill list                     # show where installed
```

Each agent has its own skill directory convention; the installer
knows where to drop the file and how to write whatever manifest the
agent needs. For Claude Code this means writing to
`~/.claude/skills/agent-hooks/` with the correct frontmatter shape
(name, description, trigger); for others the shape differs but the
source skill is the same markdown.

**Installation via the agent's own skills command**: agents that
support `/skill install <url>` or similar can install directly from
the repo:

```
/skill install https://raw.githubusercontent.com/pm990320/agent-hooks/main/templates/skills/agent-hooks.skill.md
```

The skill file's frontmatter identifies it as usable by any
compatible agent harness.

**Auto-install during `init`**: if `agent-hooks init` detects an
agent, it offers to install the skill for that agent as part of
the scaffolding flow (prompted, not silent). `init --with-skill`
skips the prompt. `init --no-skill` skips the install entirely.

**Versioning**: the skill file is embedded in the binary and pinned
to the agent-hooks version that shipped it. When
the user upgrades agent-hooks, `agent-hooks skill install` offers to
refresh the installed skill. Doctor detects stale skill versions
and suggests a refresh.

**Keeping it honest**: the skill content is generated from the same
source-of-truth markdown fragments that feed the "For AI coding
agents" README section, so the two can't drift. A build-time script
assembles them.

---

## 6a. Agent feedback prompts ("next-step hints")

Every time a step runs — pass or fail — agent-hooks emits a small
**prompt block** to stderr (and optionally to a file) that tells the
calling agent what to do next. Humans skim over it; agents read it
as instructions. Think of it as structured error messages with
suggested actions.

### 6a.1 Why

Agents get much better results when their tool output includes an
explicit "what to do next" hint. Raw exit codes and stack traces
leave them guessing. A one-line suggestion like *"3 tests failed.
Read test-results/html/index.html for details, then re-run with
--files to iterate on just the failing specs."* is dramatically
faster than letting the model deduce the same thing from output
parsing.

This is especially valuable for tools that produce rich side-effect
artifacts (Playwright traces, coverage reports, Playwright-Checkpoint
manifests) that an agent wouldn't know to look at otherwise.

### 6a.2 Shape of a prompt block

Emitted after each step. Format is stable and machine-readable so
agents can parse it reliably:

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
  - Review playwright-checkpoint artifacts in test-results/checkpoints/
    for each failing test — screenshots, accessibility, console errors,
    and web vitals are captured per checkpoint.
  - Re-run only the failing specs with:
      agent-hooks run e2e --files "e2e/auth/login.spec.ts"
---end---
```

The `---agent-hooks:next-step---` / `---end---` fences are fixed
sentinels so agents can locate the block without regex guessing.
Everything between the fences is YAML.

Output is gated by a context flag:

- **Agent context** (running under Claude Code / Codex / Cursor, or
  `--agent` flag, or `AGENT_HOOKS_AGENT=1` env) → prompts always
  emitted
- **Interactive TTY with no agent** → prompts emitted on failure only
- **CI** → prompts emitted on failure, also written to
  `agent-hooks-report.yml` for PR-comment tools
- **`--no-prompts`** → never emit

### 6a.3 User-defined prompts per step

Every step can define `on-success:` and `on-failure:` prompt
templates in config:

```yaml
steps:
  e2e:
    run: playwright test
    tags: [slow, e2e]
    prompts:
      on-success: |
        E2E passed. Checkpoint artifacts for this run are in
        test-results/checkpoints/ — consider reviewing them for any
        accessibility regressions or unexpected console errors that
        slipped past assertions.
      on-failure: |
        E2E failed. Inspect test-results/html/index.html for the
        failing specs. For each failure, the matching folder in
        test-results/checkpoints/ contains a screenshot, accessibility
        audit, console errors, and web vitals at the moment of failure.
        Re-run only the failing specs with:
          agent-hooks run e2e --files "<failing-spec-paths>"
```

Templates support a limited variable set: `{step}`, `{duration}`,
`{exit_code}`, `{files}`, `{artifacts}`, `{summary}`. No Turing-
complete templating — keep it declarative.

### 6a.4 Default prompts (sensible out-of-the-box behavior)

When no user prompt is defined, agent-hooks synthesizes a default
based on the step type and detected tools:

| Step tag / detector | Default on-failure hint |
|---|---|
| `lint` | "Lint failed on N files. Run `agent-hooks fix lint` to auto-fix, or edit the files directly. Re-run with `agent-hooks run lint --files <paths>`." |
| `typecheck` | "Typecheck failed with N errors. The first error is at `<file:line>`. Typecheck is project-wide — fix and re-run." |
| `test` (unit) | "N tests failed. Re-run only failing tests with `agent-hooks run test --files <test-paths>`." |
| `e2e` + playwright | "Playwright run failed. See `test-results/html/index.html`. Re-run failing specs with `--files`." |
| `e2e` + playwright-checkpoint detected | *(adds the checkpoint review suggestion — see §6a.5)* |
| `build` | "Build failed. See the error above. Build is project-wide; no file-targeted re-run available." |
| any step with `requires` missing | "Step skipped due to missing: `<list>`. Install the missing tool or run `agent-hooks doctor --fix`." |

Defaults are in `src/prompts/defaults.ts` as a lookup table, keyed by
(tag, detector). Trivially extensible — adding a new entry is a
one-line change.

### 6a.5 Playwright-Checkpoint integration (first-class)

[playwright-checkpoint](https://github.com/pm990320/playwright-checkpoint)
captures structured page snapshots (screenshots, HTML, accessibility
via axe, web vitals, console/network errors, metadata) into
`test-results/` during Playwright runs, with an HTML report generated
by its global teardown. This is exactly the kind of rich side-effect
artifact that agents benefit from being told about explicitly.

**Detection**: agent-hooks looks for any of:

1. `playwright-checkpoint` in `package.json` dependencies
2. `import ... from 'playwright-checkpoint'` in test files under
   `e2e/`, `tests/`, `test/`, or `playwright/`
3. `globalTeardown: 'playwright-checkpoint/teardown'` in
   `playwright.config.{ts,js,mjs}`

Any match → Playwright-Checkpoint is considered active.

**Doctor surfaces it**:

```
Playwright-Checkpoint:
  ✓ detected via playwright.config.ts globalTeardown
  ✓ report output: ./report/index.html
  ✓ checkpoint artifacts: test-results/checkpoints/
  → agent prompts will suggest reviewing checkpoint artifacts
    after e2e runs
```

**When Playwright is detected but Playwright-Checkpoint is not**,
doctor promotes it:

```
⚠ Playwright detected without playwright-checkpoint
  → playwright-checkpoint captures screenshots, accessibility audits,
    web vitals, and console/network errors per checkpoint during e2e
    runs, giving agents structured artifacts to review after a test
    run instead of just pass/fail exit codes.
  → install with: bun add -d playwright-checkpoint
  → see: https://github.com/pm990320/playwright-checkpoint
```

The promotion is one-time and suppressible (`doctor --quiet` or a
`doctor.suppress: [playwright-checkpoint]` config key) so it doesn't
become nag-ware.

**Default prompts are upgraded** when Playwright-Checkpoint is
detected. The `e2e` default on-failure prompt becomes:

```
Playwright run failed ({summary}). For each failing spec:

1. Open test-results/html/index.html for the Playwright report.
2. Review the matching checkpoint folder in
   test-results/checkpoints/<spec-name>/ — each checkpoint contains:
     - page.png (screenshot at the checkpoint)
     - axe.json (accessibility audit findings)
     - web-vitals.json (CLS, LCP, FCP, INP, TTFB)
     - console-errors.json (console + page errors since last checkpoint)
     - failed-requests.json (network failures since last checkpoint)
   Check these for regressions that may have caused or contributed
   to the failure beyond the assertion itself.
3. Re-run only the failing specs:
     agent-hooks run e2e --files "<failing-spec-paths>"
```

And the `on-success` prompt becomes:

```
E2E passed. Playwright-Checkpoint artifacts are in
test-results/checkpoints/ — it's worth a final pass over the
screenshots and axe.json files for any visual regressions or
accessibility issues that didn't trip an assertion. Report:
./report/index.html
```

This gives agents a concrete "extra pass of security/checking" loop
without any per-repo configuration — just detect Playwright-Checkpoint
and the defaults do the right thing.

### 6a.6 Artifact discovery

For the prompt block's `artifacts:` list, agent-hooks inspects the
filesystem *before* and *after* each step and diffs common output
paths:

- `test-results/` (Playwright default)
- `coverage/`, `.coverage/`, `htmlcov/`
- `report/`, `reports/`, `playwright-report/`
- `dist/`, `build/`, `.next/`
- `target/` (Rust)
- user-declared paths via `artifacts: [path1, path2]` on the step

Only paths that actually exist and changed during the step are
included. This keeps the prompt block honest — no broken links to
files that weren't generated.

---

## 7. Beads integration

Triggered when `.beads/` exists (or `beads.enabled: true`).

- **`pre-commit: stage`** — before the pre-commit pipeline runs, `git add`
  any modified files under `.beads/` so they go in the same commit.
- **`post-sync: commit`** — provide `agent-hooks beads post-sync` which
  runs `bd sync` and, if it produced changes, makes a follow-up commit with
  a conventional message (`chore(beads): sync`) and `[claude]` marker if
  running under a coding agent.
- Agents can call `agent-hooks beads post-sync` at the end of their
  turn to eliminate the manual follow-up commit pattern.

---

## 8. Project layout

```
agent-hooks/
├── PLAN.md                        ← this file
├── action.yml                     ← shipped composite GitHub Action (§2a)
├── package.json
├── tsconfig.json
├── bunfig.toml
├── schema.json                    ← generated, committed (v1)
├── src/
│   ├── cli.ts                     ← commander wiring
│   ├── commands/
│   │   ├── init.ts
│   │   ├── install.ts
│   │   ├── ci.ts
│   │   ├── run.ts
│   │   ├── lint.ts                ← thin shortcut
│   │   ├── test.ts
│   │   ├── build.ts
│   │   ├── typecheck.ts
│   │   ├── fix.ts
│   │   ├── doctor.ts
│   │   ├── schema.ts
│   │   ├── list.ts
│   │   ├── agent.ts               ← install/list/uninstall
│   │   └── beads.ts
│   ├── config/
│   │   ├── schema.ts              ← zod definitions (source of truth)
│   │   ├── load.ts                ← find + parse + validate
│   │   ├── merge.ts               ← main + local merge
│   │   └── types.ts               ← inferred TS types
│   ├── runners/
│   │   ├── exec.ts                ← child process wrapper
│   │   ├── pipeline.ts            ← sequential/parallel orchestration
│   │   ├── step.ts                ← single-step execution
│   │   └── files.ts               ← scope resolution (changed/staged/glob)
│   ├── integrations/
│   │   ├── git/
│   │   │   ├── install.ts         ← write .git/hooks/ stubs
│   │   │   ├── stub.ts            ← shell stub template + hash header
│   │   │   └── detect.ts          ← inspect existing hooks for conflicts
│   │   ├── beads/
│   │   │   └── index.ts
│   │   └── agents/
│   │       ├── claude-code.ts
│   │       ├── codex.ts
│   │       ├── cursor.ts
│   │       └── generic.ts
│   ├── reporters/
│   │   ├── console.ts             ← human-readable
│   │   └── github-actions.ts      ← ::group::/::error:: annotations
│   ├── util/
│   │   ├── git.ts
│   │   ├── prompt.ts
│   │   ├── diff.ts
│   │   └── fs.ts
│   └── version.ts
├── templates/
│   ├── agent-hooks.yml.tmpl
│   ├── github-actions.yml.tmpl
│   └── readme-snippet.md.tmpl
├── test/
│   ├── unit/
│   └── e2e/                       ← runs built binary against fixture repos
└── scripts/
    ├── build-binaries.ts          ← cross-compile all targets
    ├── generate-schema.ts
    └── release.ts
```

---

## 9. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Runtime | **Bun** | Fast, bundles to single binary, TS out of the box. |
| CLI framework | **commander** | User preference, stable, familiar. |
| Config validation | **zod** + **zod-to-json-schema** | Single source of truth, auto schema. |
| YAML | **yaml** (eemeli/yaml) | Preserves comments, best-in-class. |
| JSON5 | **json5** | Optional config format. |
| Prompts | **@clack/prompts** | Nice DX for `init`. |
| Diffing | **diff** | For init conflict review. |
| Process exec | `Bun.spawn` | Native, fast, no deps. |
| Testing | **bun:test** + fixture repos | Runs the built binary end-to-end. |
| Linting self | itself, dogfooded | Once v0 works. |

---

## 10. Milestones

Each milestone is a small, demo-able slice.

### M0 — Skeleton
- `package.json`, `tsconfig.json`, `bunfig.toml`
- `src/cli.ts` with commander, `version` + `help` wired
- `bun build --compile` produces a working binary
- GH Actions workflow that builds all 5 target binaries on push

### M1 — Config + schema
- Zod schema for the config shape above
- `load.ts` finds and parses config (.yml/.yaml/.json/.json5)
- `agent-hooks schema` command
- `agent-hooks doctor` validates config and prints errors

### M2 — Run + CI
- `agent-hooks run <step>` executes a single step
- `agent-hooks run <pipeline>` executes a pipeline sequentially
- `agent-hooks ci` wired as alias
- `--files`, `--changed`, `--staged`, `--all` scope flags
- GH Actions reporter

### M3 — Init + git hook installer
- `src/integrations/git/install.ts` writes `.git/hooks/<name>` shell
  stubs with a managed-by header + config SHA256
- `agent-hooks init` scaffolds `.config/agent-hooks.yml` and installs
  hooks based on the `git.hooks` section
- Conflict handling for pre-existing `.git/hooks/*` files with diff +
  prompt (append, replace, skip)
- `agent-hooks install [--if-missing]` is idempotent and hash-aware
- Postinstall wiring in Node projects (see §4.4a)

### M4 — Agent integrations
- Claude Code integration (most important — user's primary tool)
- Generic integration
- Codex + Cursor stubs

### M5 — Beads integration
- Auto-detect `.beads/`
- Pre-commit staging
- `agent-hooks beads post-sync` command

### M6 — Distribution polish
- `scripts/install.sh` standalone binary installer
- Composite GitHub Action (`action.yml`) + rolling `v1` tag maintenance
- `init --with-github-actions` workflow scaffolding (§4.3)
- Homebrew tap (optional)
- Docs site or README with full config reference
- First real `agent-hooks` release (v0.1.0)

### M7 — Dogfood
- Use agent-hooks in the agent-hooks repo itself
- Use it in 1–2 other repos to find rough edges

---

## 11. Integration tests (fixture projects)

Unit tests cover every line of `src/`. They don't cover *the lived
lifecycle* — what happens when a real user runs `init`, commits a
file, triggers a Claude Code hook, and calls `agent-hooks ci`. For
that we have a second test tier: **integration tests against fixture
projects**, one per supported language, exercising the full
end-to-end flow inside a disposable temp directory.

### 11.1 Goals

1. **Catch real-lifecycle regressions** — init writing the wrong
   path, hook stubs not executable, agent dispatch parsing stdin
   incorrectly, env discovery failing in a git-hook subshell. These
   bugs are invisible to unit tests but obvious the first time a
   user hits them.
2. **Prove every language template works** — if we claim to support
   Bun, Node+npm, pnpm, yarn, Python+uv, Python+poetry, cargo, go,
   deno, we need a fixture for each.
3. **Exercise every CLI command once in a realistic setting** —
   `init`, `install`, `run`, `ci`, `lint`/`test`/`build` shortcuts,
   `fix`, `hook git pre-commit`, `hook claude PostToolUse`, `doctor`,
   `agent install claude`, `skill install claude`, `beads post-sync`.
4. **No network, no real tool installs.** Tests must run in seconds
   on a clean CI runner with nothing but git, bun, and our code.

### 11.2 Fixture shape

Fixtures live under `test/fixtures/<language>/` and are committed to
the repo. They're **never mutated** by tests — every test starts by
copying the fixture to a fresh tempdir.

```
test/fixtures/
├── bun-ts/
│   ├── .config/
│   │   └── agent-hooks.yml       # pre-scaffolded, or absent for init tests
│   ├── scripts/
│   │   ├── fake-eslint.sh        # +x, exits 0, echoes "lint ok"
│   │   ├── fake-tsc.sh
│   │   ├── fake-vitest.sh
│   │   └── failing-eslint.sh     # for failure-path tests
│   ├── src/
│   │   ├── a.ts
│   │   ├── b.ts
│   │   └── has space.ts          # stress-tests shell quoting
│   ├── e2e/
│   │   └── smoke.spec.ts
│   ├── package.json
│   └── bun.lockb                 # empty touch file — makes the
│                                 # bun detector fire
├── node-npm/                     # same shape, npm flavour
├── node-pnpm/
├── python-uv/
│   ├── pyproject.toml
│   ├── uv.lock                   # empty touch file
│   ├── scripts/
│   │   ├── fake-ruff.sh
│   │   └── fake-pytest.sh
│   └── src/my_pkg/__init__.py
├── cargo/
│   ├── Cargo.toml
│   ├── scripts/
│   │   └── fake-cargo.sh
│   └── src/main.rs
└── generic/
    ├── scripts/
    │   └── fake-tool.sh
    └── any-file.txt
```

**Why fake scripts instead of real tools?** We want integration
tests to run without a working ESLint install / Python venv / Rust
toolchain / etc. The fake scripts match the real tools' CLI shape
(accept the same args, exit with predictable codes, write the same
kind of output) but do nothing. The step runner's exec path is
real — only the commands at the leaves are fakes.

Failing variants (`failing-eslint.sh`, etc.) let us test the failure
path without special-casing the happy tests.

### 11.3 Harness

```
test/integration/
├── support/
│   ├── fixture.ts          # copyFixture(), gitInit(), cleanup()
│   ├── cli.ts              # runCli(args, cwd, stdin) via imported main()
│   ├── expect.ts           # assertFileExists, assertFileContains, …
│   └── claude-input.ts     # build hook input JSON per Claude Code's shape
└── <test files>
```

**`copyFixture(name)`** returns a `{ cwd, cleanup }` pair: mkdtemp,
recursive copy of `test/fixtures/<name>/`, chmod +x on `scripts/*`,
`git init -b main`, `git config user.email test@example.com`,
`git config user.name test`, `git add .`, `git commit -m "init"`.

**`runCli(argv, cwd)`** imports `main()` from `src/cli.ts` directly
and calls it with the given argv and an overridden `process.cwd()`
via `chdir`. Captures stdout + stderr into strings. Returns
`{ exitCode, stdout, stderr }`. Does not spawn a subprocess — faster,
and we get real stack traces on failure.

**`claudeInput()`** builds a valid Claude Code hook input JSON blob
with a `tool_use` event and a file list, so `hook claude PostToolUse`
has something to parse.

### 11.4 Lifecycle tests

Per-fixture, we run a consistent suite of lifecycle scenarios:

| Scenario | Description |
|---|---|
| `init on empty repo` | Run `agent-hooks init --with-github-actions`. Assert `.config/agent-hooks.yml`, `.git/hooks/pre-commit` stub, `.github/workflows/agent-hooks.yml` exist. Assert the stub is executable and carries the managed-by header. |
| `init with existing config` | Copy fixture that already has `.config/agent-hooks.yml`. Run `init`. Assert it detects existing config and prompts / preserves depending on `--force`. |
| `install --if-missing is idempotent` | Run `install` twice. Assert the second call is a no-op (no mtime change on the stub). |
| `doctor on valid config` | Exits 0, prints green checks. |
| `doctor on broken config` | Pipelines reference undefined step → exit 2, readable error. |
| `run lint --all` | Executes the fake eslint script once, exits 0. |
| `run lint` with failing variant | Uses `failing-eslint.sh`, exits 1, summary shows failure. |
| `run test --files src/a.ts` | Fake vitest script receives only the explicit file. |
| `run e2e` excluded from agent-edit | `hook claude PostToolUse` with an edit doesn't trigger e2e. |
| `ci` runs all steps in order | Sequential execution, aggregate exit code reflects max. |
| `hook git pre-commit` via .git/hooks stub | Stage a file, fire the installed stub, assert the pre-commit pipeline ran with the staged file. |
| `hook claude PostToolUse` via stdin | Feed JSON on stdin, assert the agent-edit pipeline ran with the edited files. |
| `commit message [skip agent-hooks]` | Hook runs but skips everything. |
| `commit with --no-verify` | Hook not invoked at all (git behavior). |
| `lint with paths containing spaces` | `has space.ts` stress-tests shell quoting end-to-end. |
| `postinstall in Node fixtures` | After `init --with-postinstall`, `package.json` contains the entry. |
| `beads post-sync` | Fake `bd sync` script produces a change; follow-up commit is created. |

### 11.5 Test organization

- One file per fixture: `test/integration/bun-ts.test.ts`,
  `test/integration/node-npm.test.ts`, etc.
- Each file imports shared scenarios from
  `test/integration/scenarios.ts` and parameterizes by fixture name.
- Scenarios that only apply to one fixture (e.g. postinstall for
  Node) live alongside the fixture file as extra tests.
- Tests run under `bun test` alongside the unit suite. They share
  coverage tracking — running the real code path from `main()` is
  what we want.

### 11.6 CI integration

The CI workflow (`.github/workflows/ci.yml`) already runs
`bun test --coverage`. Integration tests opt into that same run. On
macOS + Linux matrix runners they should take < 15 seconds total.
On Windows (where shell stubs need `.cmd` wrappers) we run a subset
to verify the Windows-specific path works.

### 11.7 Rollout by milestone

Integration tests land incrementally alongside the features they
cover:

| Milestone | Scenarios enabled |
|---|---|
| M2 (run + ci) | `run lint --all`, `run lint` failing, `run test --files`, `ci` |
| M3 (init + git hooks) | `init`, `install`, `hook git pre-commit`, `doctor` |
| M4 (agent integrations) | `hook claude PostToolUse`, `agent install claude`, `skill install claude` |
| M5 (beads) | `beads post-sync` |
| M7 (dogfood) | Full matrix across every fixture + CI runs them |

This lets us ship integration tests as a forcing function without
waiting for the whole tool to be done.

---

## 12. Open questions

1. **Config format default**: YAML or JSON5? YAML is more common in CI
   tooling. Proposal: YAML.
2. **`run` step DSL**: support structured `args: []` form in addition to
   string `run:`? Proposal: string-only in v1, add structured form if needed.
3. **Caching**: skip for v1. Add in v2 keyed on input file hashes.
4. **Windows**: test on Windows CI but treat as best-effort in v1 — most
   real usage is macOS/Linux.
5. **Monorepo support**: single config at repo root in v1. Per-package
   configs and dependency graphs are v2+.
6. **Plugin API surface**: in v1, "plugins" = copy-paste an integration
   file. Formal plugin loader is v2+.

---

## 13. README + onboarding

The README is the front door for two audiences: human developers
skimming to decide if this is worth trying, and coding agents reading
it wholesale as context. Both win from the same optimization: **copy-
pasteable commands, short paragraphs, tables over prose, no clever
writing**.

### 13.1 README structure

```
# agent-hooks

> One command for CI, pre-commit hooks, and agent feedback loops.
> Ships as a single binary.

[badges: build status, license]

## What it does
  3 bullet points, 1 line each:
  - Replaces your per-repo CI glue with `agent-hooks ci`.
  - Runs the same checks locally that GitHub Actions runs remotely.
  - Gives coding agents sub-second feedback on file edits.
  - Installs its own git hook stubs — no second tool to configure.

## Install
  (see §13.2 — multiple options, tabbed)

## Quick start
  Four commands:
  ```
  cd your-repo
  agent-hooks init          # scaffolds config + hooks, detects stack
  agent-hooks doctor        # sanity check
  agent-hooks ci            # run the full pipeline
  ```
  Screenshot/asciinema of `init` running against a node repo.

## Your first config
  Show a 15-line annotated .config/agent-hooks.yml.
  Explain what each section does in one sentence.

## The three contexts (same config, three entry points)
  | Context | Trigger | Scope | Purpose |
  |---|---|---|---|
  | CI | GitHub Actions | all files | `agent-hooks ci` |
  | Pre-commit | git commit | staged files | fail-fast check |
  | Agent edit | Claude Code PostToolUse | edited files | sub-second feedback |

## GitHub Actions
  The 5-line composite action snippet from §2a.

## Coding agent integration
  Claude Code section with copy-paste `.claude/settings.json` block
  showing the canonical `agent-hooks hook claude PostToolUse` wiring
  (§4.5).
  Codex + Cursor sections — same shape, different agent name.
  "Custom agent?" → `agent-hooks agent install generic`.
  Pipeline-to-hook mapping lives in `.config/agent-hooks.yml` under
  `agents.<name>.hooks`, not in the agent's settings file.

## Config reference
  Table of every top-level key with one-line description + link to
  the full reference page.

## CLI reference
  Table from §4, one line per command.

## How it works
  Two paragraphs: agent-hooks writes shell stubs into `.git/hooks/`,
  then handles everything (file resolution, env discovery, step
  execution, agent glue) itself. Link to ARCHITECTURE.md for the
  long version.

## FAQ
  - Does this wrap another tool like lefthook / husky?   → no
  - What if I already use husky / pre-commit / lint-staged?  → migration notes
  - Can I just call eslint directly?                   → yes, but here's why not
  - Does this work in monorepos?                       → v1: single config at root
  - How do I skip a hook temporarily?                  → [skip agent-hooks] or --no-verify
  - Windows?                                            → best-effort in v1
  - How do I contribute a new agent integration?       → link to CONTRIBUTING.md

## For AI coding agents
  A dedicated, explicit section agents can parse deterministically.
  See §13.3.

## License
  MIT.
```

### 13.2 Installation instructions

One install path, one code path.

**Option 1 — standalone binary (recommended):**
```bash
# macOS / Linux
curl -fsSL https://agent-hooks.dev/install.sh | sh

# or pin a version
curl -fsSL https://agent-hooks.dev/install.sh | sh -s -- --version v0.1.0
```

The install script:
1. Detects OS + arch
2. Downloads the matching binary from the latest GitHub Release
3. Installs to `~/.local/bin/agent-hooks` (override with `--dir`)
4. Runs `--version` as a smoke test
5. Prints PATH guidance if the install dir isn't on PATH

**Option 2 — Homebrew (deferred to v0.2):**
```bash
brew install pm990320/tap/agent-hooks
```

**Option 3 — GitHub Action (for CI only, no local install needed):**
See §2a — drop 5 lines into `.github/workflows/ci.yml`. The action
performs the same binary download under the hood.

No npm package. See §2 for why.

### 13.3 "For AI coding agents" README section

A short, deterministic block agents can act on without ambiguity.
Draft content:

```markdown
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
spaces. Example:
`agent-hooks run agent-edit --files "src/foo.ts" "src/bar.ts"`

**Skipping**: if a step is failing on infra (missing dep, etc.), it
will already warn-skip. If you need to skip deliberately, add
`[skip agent-hooks]` to the commit message or use `--skip <step>`.

**Beads**: after `bd sync`, run `agent-hooks beads post-sync` to
create the follow-up commit automatically.

**Config location**: `.config/agent-hooks.yml`. It's JSON-Schema
validated; read it to see what steps and pipelines are defined.
```

This section exists because agents (and pair-programming humans
skimming for the same info) want reference, not narrative.

### 13.4 Project-local onboarding snippet

`agent-hooks init` can optionally append a short section to the repo's
own README:

```
## Development

This project uses [agent-hooks](https://agent-hooks.dev) for CI and
pre-commit hooks.

- `agent-hooks ci` — run the full CI pipeline locally
- `agent-hooks run lint` — lint changed files
- `agent-hooks run test` — test changed files
- `agent-hooks doctor` — diagnose environment issues
```

Behind a prompt + `--update-readme` flag. Detects and skips if a
section with the `agent-hooks` marker already exists. Never overwrites
existing README content without a diff + confirmation.

---

## 14. Success criteria for v0.1.0

- [ ] `agent-hooks init` on an empty repo produces working config + hooks
- [ ] `agent-hooks ci` runs green in GitHub Actions using only that one command
- [ ] `agent-hooks run test --files foo.ts` runs only the relevant test file
- [ ] Claude Code PostToolUse hook runs `agent-edit` pipeline in <1s on a
      small change (excluding actual lint/test runtime)
- [ ] Schema validation errors are readable, not stack traces
- [ ] Single binary on macOS ARM64 < 60 MB
- [ ] `curl -fsSL .../install.sh | sh` installs and runs on macOS + Linux
