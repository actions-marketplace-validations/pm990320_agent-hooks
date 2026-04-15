/**
 * Build a JSON blob that matches Claude Code's hook input shape. Used to
 * feed `agent-hooks hook claude <HookName>` over stdin in integration
 * tests.
 *
 * The shape mirrors Claude Code's documented `PostToolUse` payload. We
 * only populate the fields our handler cares about — everything else is
 * left undefined so the schema has room to evolve.
 */
export interface ClaudeHookInputOptions {
  readonly toolName: string;
  readonly files: readonly string[];
  readonly hookEventName?: string;
}

export function buildClaudeInput(
  options: ClaudeHookInputOptions,
): string {
  const payload = {
    hook_event_name: options.hookEventName ?? "PostToolUse",
    tool_name: options.toolName,
    tool_input: {
      // Claude Code uses `file_path` (singular) for single-file tools
      // and we pass a list here so the handler can cope with both.
      file_path: options.files[0] ?? "",
      file_paths: options.files,
    },
  };
  return `${JSON.stringify(payload)}\n`;
}
