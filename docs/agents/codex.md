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
        "matcher": "apply_patch|Edit|Write|MultiEdit",
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
        - matcher: "apply_patch|Edit|Write|MultiEdit"
          pipeline: agent-edit
```

Then install:

```bash
agent-hooks agent install codex              # project scope
agent-hooks agent install codex --scope user # if you want ~/.codex/
```

## Known Codex limitations (upstream, not agent-hooks)

- **PostToolUse can fire for non-file-changing tools such as `Bash`**.
  agent-hooks fast-skips those Codex invocations and only dispatches
  PostToolUse for file-edit tool names (`apply_patch`, `Edit`, `Write`,
  `MultiEdit`).
- **Codex file-edit payloads may not include explicit file paths**.
  When the normalized `files` list is empty for a dispatched file-edit
  event, agent-hooks falls back to the repo's changed files.
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
