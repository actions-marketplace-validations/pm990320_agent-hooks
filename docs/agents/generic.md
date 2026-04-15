# Generic

For any agent agent-hooks doesn't ship a dedicated integration for.

## Install

```
agent-hooks agent install generic
```

Prints a shell snippet that reads files from stdin, a file, or an
env var, and calls `agent-hooks hook generic edit`. Drop the snippet
into whatever hook/trigger mechanism the agent exposes.

## Input format

The generic handler accepts files from three sources, in order:

1. A JSON object on stdin with a `files` array
2. A newline-delimited file list piped to stdin
3. The `$AGENT_HOOKS_FILES` environment variable (space- or
   newline-separated)

## Config example

```yaml
agents:
  generic:
    enabled: auto
    hooks:
      edit:
        - pipeline: agent-edit
```
