# Architecture

agent-hooks is a thin orchestrator. It doesn't reimplement test
runners (your tools do), and it doesn't parse your codebase. It sits
in the middle and makes sure the same checks run everywhere: CI,
pre-commit, agent edits.

## The three entry points, one pipeline

```
  ┌──────────────────┐
  │ GitHub Actions   │──┐
  └──────────────────┘  │
                        │
  ┌──────────────────┐  │    ┌─────────────────┐
  │ git pre-commit   │──┼───▶│  agent-hooks    │──▶ step runner
  │ (.git/hooks/…)   │  │    │  pipeline       │
  └──────────────────┘  │    │  resolver       │
                        │    └─────────────────┘
  ┌──────────────────┐  │
  │ Claude Code      │──┘
  │ PostToolUse      │
  └──────────────────┘
```

Each entry point hands agent-hooks a file list (or none) and a
pipeline name. Everything downstream is identical.

## Responsibilities

| Component | Owns |
|---|---|
| **agent-hooks config** | What steps exist, what pipelines group them, which git hooks and agent hooks map to which pipelines. |
| **Git hook installer** | Writing shell stubs into `.git/hooks/<name>` that `exec agent-hooks hook git <name>`. Tracks a managed-by header + config-hash so `--if-missing` is a fast no-op. |
| **File resolver** | Turning a scope (`explicit`/`staged`/`changed`/`all`) into a file list via git + picomatch. One code path for every entry point. |
| **Step runner** | Building the command line per invocation mode, executing, collecting exit code. |
| **Pipeline runner** | Resolving pipeline → step list, applying tag filters, sequential or parallel execution. |
| **Reporter** | Formatting output per context (console, GitHub Actions annotations, agent feedback prompt). |
| **Agent integrations** | Writing the agent's native settings file so its hooks call `agent-hooks hook <agent> <name>`, and translating the agent's input format into `{ files, tool, event }`. |

## Why we own the git-hook installer

Early drafts of this design wrapped lefthook. We dropped that for a
few reasons:

1. **The primitives are already ours.** File resolution, step
   execution, and pipeline orchestration all live in `src/runners/`.
   Lefthook's core value was exactly those pieces.
2. **Two config languages is a footgun.** Generating
   `.config/lefthook.yml` from our config means every feature needs
   two implementations (ours and the translation). Bugs collect in
   the translation layer.
3. **Writing `.git/hooks/` stubs is small.** A shell stub is four
   lines; the installer is a few hundred lines counting conflict
   handling and hash tracking.
4. **`--no-verify` still works.** Git itself honors `--no-verify` and
   skips all hook stubs — we don't need another tool to give us the
   escape hatch.
5. **Binary size.** Vendoring lefthook added ~5 MB × 5 targets. Our
   Bun binary is already large; adding another runtime made it worse.

## Why one binary

Developers install a lot of tools. We don't want to be one that
makes them configure a Node version or install a package manager
first. `bun build --compile` gives us a single binary per platform;
that's the *only* distribution channel. Binaries are attached to
GitHub Releases and fetched by `install.sh` or the shipped composite
action. No npm package — one artifact, one code path, no runtime
prereqs.

## Extension points

- **New stack detector**: drop a file in `src/integrations/detectors/`
  matching the `Detector` interface. Return a template fragment.
- **New agent**: drop a folder in `src/hooks/<agent>/` with handlers
  for the hooks you care about, plus an installer in
  `src/integrations/agents/<agent>/`. See [contributing](./contributing.md).
- **New invocation mode**: extend the `InvocationMode` enum in
  `src/runners/step.ts` and add the case to the command builder.
- **New reporter**: implement the `Reporter` interface under
  `src/reporters/`.

Each extension point is deliberately small. Contributing a new
integration should be under 200 lines of code in almost all cases.
