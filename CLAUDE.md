# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

_Add your build and test commands here_

```bash
# Example:
# npm install
# npm test
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_

<!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:0845b391a26f -->
## agent-hooks

This project uses [agent-hooks](https://github.com/pm990320/agent-hooks)
as the canonical entry point for CI, linting, tests, and other dev-loop
commands. **Prefer the commands below over bare tool invocations** —
they honor the project's configured pipelines, file scopes, and skip
rules.

### Core commands

- `agent-hooks ci` — run the full CI pipeline locally (exactly what GitHub Actions runs)
- `agent-hooks run <pipeline-or-step>` — run a specific pipeline or step
- `agent-hooks lint` / `test` / `build` / `typecheck` / `format` — shortcuts for the same-named pipelines
- `agent-hooks fix <step>` — run a step's auto-fix command (e.g. `agent-hooks fix lint`)
- `agent-hooks list` — list every configured step and pipeline for this project
- `agent-hooks doctor` — validate config, preflight, and environment

Run `agent-hooks list` first to discover what pipelines and steps this
project defines. Run `agent-hooks --help` for the full CLI.

### Scope flags

Shared by `run` / `ci` / shortcuts:

- `--files <paths…>` — explicit files (what agent hooks pass through)
- `--staged` — files staged for commit
- `--changed` — files changed vs the default branch merge-base
- `--all` — every tracked file

### Skipping hooks

When you legitimately need to bypass the pipeline for a commit:

- Commit message tag: `[skip agent-hooks]` or `[skip ci]` — skips everything for that commit
- Commit message scoped: `[skip lint,test]` — skips specific steps by name
- Env var: `AGENT_HOOKS_SKIP=1` (skip all) or `AGENT_HOOKS_SKIP=lint,test` (by name)
- Env var: `AGENT_HOOKS_ONLY=lint` to whitelist a single step
- CLI flags: `--skip <names>` / `--only <names>` on `run` / `ci`

Don't skip just to make a red build green — fix the underlying issue.

### Piping output

Each step emits an `---agent-hooks:next-step---` YAML block to stderr
with structured feedback (status, exit code, next action). Pass
`--no-prompts` to suppress these blocks when the caller doesn't need
them.
<!-- END AGENT-HOOKS INTEGRATION -->
