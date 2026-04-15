---
name: agent-hooks
description: Run agent-hooks CI, pre-commit, and agent-edit pipelines. Invoke when the user asks you to lint, test, or verify code in a repo that uses agent-hooks.
trigger: repo contains .config/agent-hooks.yml or agent-hooks.yml
---

# agent-hooks skill

You're in a repo that uses [agent-hooks](https://github.com/pm990320/agent-hooks)
to run CI, pre-commit hooks, and fast agent-edit feedback loops. This skill
tells you how to use it correctly.

## When to invoke

| When | Command |
|---|---|
| After editing a file | `agent-hooks run agent-edit --files <paths>` |
| Before committing | `agent-hooks run pre-commit --staged` |
| To verify CI will pass | `agent-hooks ci` |
| To see available steps | `agent-hooks list` |
| To check your environment | `agent-hooks doctor` |

## Passing file paths

Space-separated, quoted if they contain spaces:

```
agent-hooks run agent-edit --files "src/foo.ts" "src/bar.ts"
```

## Reading the output

Each step prints a one-line status entry and an overall summary. Failed
steps show `✗ <name> — failed (exit N)`. Non-zero exit from the command
means at least one step failed.

## Skip directives

If a step is failing on infrastructure (missing dep, etc.) it will already
be warn-skipped. To skip deliberately:

- `[skip agent-hooks]` in the commit message (skips all steps)
- `[skip <step>]` (skip a specific step)
- `--skip <step1>,<step2>` on the CLI
- `--only <step>` to run just one step
- `git commit --no-verify` as the ultimate escape hatch

## Adding a step

Edit `.config/agent-hooks.yml`:

```yaml
steps:
  my-step:
    run: my-tool {files}
    files: "**/*.ts"
pipelines:
  ci:
    steps: [lint, typecheck, test, my-step]
```

Pipelines are ordered lists. Tag slow steps with `slow` or `e2e` so
they're excluded from the agent-edit pipeline automatically.

## Beads

If the repo uses Beads, after running `bd sync` invoke:

```
agent-hooks beads post-sync
```

This creates the follow-up commit automatically so you don't forget.

## Playwright-Checkpoint

If `playwright-checkpoint` is installed, after an e2e run review the
artifacts in `test-results/checkpoints/<spec>/`:

- `page.png` — screenshot
- `axe.json` — accessibility audit
- `web-vitals.json` — CLS/LCP/FCP/INP/TTFB
- `console-errors.json` — console + page errors
- `failed-requests.json` — network failures

These catch regressions that didn't trip assertions.

## Config location

`.config/agent-hooks.yml`. It's JSON-schema validated — open it to see
what steps and pipelines are defined. The schema is at
`./node_modules/agent-hooks/schema.json`.
