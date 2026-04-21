# Claude Code

[Claude Code](https://code.claude.com/docs/en/hooks) is Anthropic's
official CLI for Claude. It has the most mature hook surface of the
agents agent-hooks integrates with, and is the reference
implementation for the dispatcher in
[`src/hooks/claude/`](../../src/hooks/claude/).

## Detection

agent-hooks detects Claude Code by the presence of a `.claude/`
directory in the repo root (or any ancestor up to the git root).

## Install

```
agent-hooks agent install claude
```

Writes `.claude/settings.json` with the hook wiring:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          { "type": "command", "command": "agent-hooks hook claude PostToolUse" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "agent-hooks hook claude Stop" }
        ]
      }
    ]
  }
}
```

## Supported hook names

- `PreToolUse`
- `PostToolUse`
- `UserPromptSubmit`
- `Stop`
- `SubagentStop`
- `Notification`
- `PreCompact`

List them at any time with:

```
agent-hooks hook claude --list
```

## Input format

Claude Code passes hook context as JSON on stdin. agent-hooks reads
it, parses `{ tool, files, event }`, and looks up the matching rule
in `agents.claude-code.hooks.<HookName>` in your config.

## Config example

```yaml
agents:
  claude-code:
    enabled: auto
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

First matching rule wins. Matchers are regex over the tool name.

## Monorepos

In monorepo mode, Claude still calls one repo-level command:

```json
{ "type": "command", "command": "agent-hooks hook claude PostToolUse" }
```

agent-hooks then:

- loads the parent root manifest
- runs any matching root Claude hook rule
- routes edited files to affected workspaces
- runs each affected workspace's own `agents.claude-code.hooks.*` rule

So a Claude edit touching `services/api/**` runs with service-relative
paths inside that workspace config, even when Claude was launched from
the repo root.
