# Codex

[OpenAI Codex](https://developers.openai.com/codex/) is OpenAI's
coding agent CLI.

## Status

agent-hooks has **native hook-handler support** for Codex as well as
the older skill-file install:

- Automatic PostToolUse dispatch: configure rules under `agents.codex`
  in `.config/agent-hooks.yml` and `agent-hooks agent install codex`
  writes `.codex/hooks.json` + enables the feature flag in
  `.codex/config.toml`.
- Skill file still available: the agent-hooks "how to use me" text can
  be dropped at `.codex/skills/agent-hooks.md`.

Project scope is the default and recommended — nothing is written to
`~/.codex/` unless you pass `--scope user` explicitly.

## What gets written

At project scope (default), install touches two files:

**`.codex/hooks.json`** — generated from your `agents.codex.hooks`
rules. Same JSON shape as Claude Code's `settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "agent-hooks hook codex PostToolUse" }
        ]
      }
    ]
  }
}
```

**`.codex/config.toml`** — `[features] codex_hooks = true` is spliced
in if missing. Codex gates hook dispatch behind this flag (as of early
2026 the feature is still marked experimental upstream). If you
already have a `[features]` section the flag is inserted into it; if
not a new section is appended; if `codex_hooks = true` is already
present anywhere the file is left alone.

## Configure

```yaml
# .config/agent-hooks.yml
agents:
  codex:
    hooks:
      PostToolUse:
        - matcher: "Bash"
          pipeline: agent-edit
```

Then install:

```bash
agent-hooks agent install codex              # project scope
agent-hooks agent install codex --scope user # if you want ~/.codex/
```

## Known Codex limitations (upstream, not agent-hooks)

- **PostToolUse currently only emits for the `Bash` tool**. File-editing
  operations (`Write`, `ApplyPatch`) don't fire hooks yet — [tracked
  upstream](https://github.com/openai/codex/issues/17794). The handler
  here will pick them up automatically once Codex emits them.
- **The hook payload for Bash only carries `tool_input.command`**, not
  file paths. That means agent-hooks' normalized `files` list is empty
  for Codex PostToolUse events, so your codex-triggered pipeline should
  lean on project-scoped steps (which is typical for `agent-edit`
  pipelines anyway).
- **Hooks are disabled on Windows** in the current Codex build.

## Skill install (optional, orthogonal to hooks)

```bash
agent-hooks agent skill install codex            # ~/.codex/skills/
agent-hooks agent skill install codex --project  # repo-local
agent-hooks agent skill uninstall codex
agent-hooks agent skill list                     # show installed
```

The skill file teaches Codex's own agent how to invoke agent-hooks
commands. It doesn't replace the hook integration — it complements
it.
