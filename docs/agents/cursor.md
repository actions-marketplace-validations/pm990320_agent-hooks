# Cursor

[Cursor](https://cursor.com/docs/) is an AI-first code editor.

## Status

agent-hooks has **skill-file support** for Cursor but no native
hook handler yet. That means:

- You can install the agent-hooks skill for Cursor so the agent
  knows how to invoke agent-hooks commands.
- There is no automatic tool-call → pipeline dispatch. Cursor's
  hook surface is still evolving and we don't lock users in to a
  shape that's likely to change.

If you need programmatic dispatch, use the
[generic handler](./generic.md).

## Install the skill

```
agent-hooks agent skill install cursor            # ~/.cursor/skills/
agent-hooks agent skill install cursor --project  # repo-local
agent-hooks agent skill uninstall cursor
agent-hooks agent skill list                      # show installed
```

## Use the generic handler for hook dispatch

```
agent-hooks hook generic edit
```

Pipe file paths in on stdin (one per line) or pass them as
arguments.
