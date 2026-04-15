# Agent integration

agent-hooks integrates with coding agents (Claude Code, Codex,
Cursor, …) via a single standardized CLI entry point.

## The `hook` command

Every agent hook — Claude Code's `PostToolUse`, Codex's equivalent,
Cursor's — goes through:

```
agent-hooks hook <agent> <hook-name> [flags]
```

### Why this shape

1. **One entry point per agent.** Agent settings files always call
   `agent-hooks hook claude <name>`, never bespoke shell snippets.
2. **Hook-to-pipeline mapping lives in `.config/agent-hooks.yml`**,
   not in `.claude/settings.json`. Change which pipeline runs on
   edit? Edit agent-hooks config, don't touch agent settings.
3. **Handlers know how to parse each agent's input format.** Claude
   Code passes JSON on stdin; Codex uses env vars. Users never
   think about it.
4. **Hook names match the agent's native names.** No translation
   layer.

### Dispatch flow

1. Agent-hooks reads the agent's input per that agent's API
2. Parses it into `{ files, tool, event }`
3. Looks up `agents.<name>.hooks.<HookName>` in the config for a
   matching rule
4. Dispatches to the runner: equivalent to
   `agent-hooks run <pipeline> --files <files>`
5. Emits an agent feedback prompt (see
   [troubleshooting](./troubleshooting.md#agent-feedback-prompts))
   formatted for that agent

## Supported agents

Run `agent-hooks agent list` to see every handler that's registered
and whether it's detected in your current environment.

### Native hook handlers

Agents with a dedicated handler — `agent-hooks agent install <name>`
wires their native hook surface directly through agent-hooks:

- [Claude Code](./agents/claude-code.md) — the reference
  implementation; most mature hook surface
- Gemini CLI
- OpenCode
- Cline
- Droid (Factory AI)
- Windsurf (Codeium)
- Kiro (AWS)
- Augment Code
- GitHub Copilot coding agent
- Amp (Sourcegraph)
- Kilo Code
- Kode (shareAI-lab)
- Qwen Code
- Kimi Code CLI (Moonshot AI)
- iFlow CLI
- CodeBuddy
- Cortex Code (Snowflake)
- Qoder
- Pi (pi-mono)
- Neovate
- OpenClaw

The canonical invocation is always:

```
agent-hooks hook <name> <hook-event>
```

The agent's installed settings file points at that command and
passes its native payload on stdin; agent-hooks parses and
dispatches.

### Skill-only integrations

Agents with no native handler but a supported skill file install
path:

- [Cursor](./agents/cursor.md) — skill install only
- [Codex](./agents/codex.md) — skill install only

For programmatic dispatch from these agents, use the
[generic handler](./agents/generic.md).

### Generic

- [Generic](./agents/generic.md) — fallback that reads file paths
  from stdin or args. Works with any agent that can shell out.

Adding a new agent? See [contributing](./contributing.md) — the
short version is "add a directory under `src/hooks/<name>/` and
register the handler in `src/hooks/registry.ts`."

## Handler layout

```
src/hooks/
├── claude/
│   ├── index.ts         ← registry + input parser
│   ├── pre-tool-use.ts
│   ├── post-tool-use.ts
│   ├── user-prompt-submit.ts
│   ├── stop.ts
│   ├── subagent-stop.ts
│   ├── notification.ts
│   └── pre-compact.ts
├── codex/
├── cursor/
└── generic/
```

Each handler is 20–50 lines.

## Agent skill file

agent-hooks ships an installable **skill file** that teaches agents
how to work with agent-hooks — which pipeline to invoke when, how
to read feedback prompts, how to add steps, how to handle skip
directives.

Install it into any supported agent's skills directory:

```
agent-hooks agent skill install claude            # ~/.claude/skills/
agent-hooks agent skill install cursor
agent-hooks agent skill install codex
agent-hooks agent skill install claude --project  # repo-local
agent-hooks agent skill list                      # show installed
agent-hooks agent skill uninstall claude
```

Agents that support installing skills from a URL can install
directly:

```
/skill install https://raw.githubusercontent.com/pm990320/agent-hooks/main/templates/skills/agent-hooks.skill.md
```

Pass `--with-skill <target>` to `agent-hooks init` (or
`--with-skill auto` for all three of `claude`, `cursor`, `codex`)
to install the skill as part of scaffolding. `--no-skill`
suppresses it.

## CLAUDE.md / AGENTS.md marker block

Agents reading `CLAUDE.md` or `AGENTS.md` at the project root
don't automatically know that agent-hooks is the canonical dev-loop
entry point. To teach them, agent-hooks can splice a short
instruction block into those files, delimited by HTML-comment
markers:

```
<!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:… -->
## agent-hooks
...
<!-- END AGENT-HOOKS INTEGRATION -->
```

The block body is **deliberately constant** — the same bytes for
every project, so the files stay prompt-cacheable across repos.
Project-specific details (pipeline names, fix-capable steps) stay
out of the block; the block points agents at `agent-hooks list`
instead.

`agent-hooks init` injects the block automatically when either file
already exists in the cwd; it never creates these files. Pass
`--no-agents-md` to suppress. Outside of init:

```
agent-hooks agent instructions install     # splice the block
agent-hooks agent instructions uninstall   # strip the block
agent-hooks agent instructions list        # show status + drift
```

The installer never touches content outside the markers — hand
edits elsewhere in the file are preserved byte-for-byte. Re-running
`install` after an agent-hooks upgrade refreshes a stale block in
place.

## Testing hook handlers

The easiest way to exercise a handler without an agent running is
to pipe a fixture on stdin:

```
cat fixture.json | agent-hooks hook claude PostToolUse
```

To see which events the handler supports and which are currently
configured in your `.config/agent-hooks.yml`:

```
agent-hooks hook claude --list
```
