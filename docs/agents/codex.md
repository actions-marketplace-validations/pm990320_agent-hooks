# Codex

[OpenAI Codex](https://developers.openai.com/codex/) is OpenAI's
coding agent CLI.

## Status

agent-hooks has **skill-file support** for Codex but no native hook
handler yet. That means:

- You can install the agent-hooks skill for Codex so the agent
  itself knows how to invoke agent-hooks commands.
- There is no automatic tool-call → pipeline dispatch (i.e. Codex
  doesn't have an integration like Claude Code's `PostToolUse`).

If you need programmatic dispatch, use the
[generic handler](./generic.md) — it reads file paths from stdin
and env vars, and works with any agent that can shell out.

## Install the skill

```
agent-hooks agent skill install codex            # ~/.codex/skills/
agent-hooks agent skill install codex --project  # repo-local
agent-hooks agent skill uninstall codex
agent-hooks agent skill list                     # show installed
```

## Use the generic handler for hook dispatch

```
agent-hooks hook generic edit
```

Pipe file paths in on stdin (one per line) or pass them as
arguments. Wire this into whatever post-edit hook Codex exposes
in your setup.
