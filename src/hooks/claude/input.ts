/**
 * Claude Code hook payloads are delivered as a single JSON object on
 * stdin. The fields we care about are deliberately loose — Claude Code
 * evolves its schema, and we want to keep working as long as the core
 * fields we depend on are present.
 */
export interface ClaudeHookInput {
  readonly toolName: string | null;
  readonly files: readonly string[];
  readonly hookEventName: string | null;
}

interface RawClaudeInput {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: {
    file_path?: unknown;
    file_paths?: unknown;
  };
}

function extractFiles(raw: RawClaudeInput): string[] {
  const list: string[] = [];
  const ti = raw.tool_input ?? {};

  // `file_paths` (plural, array) first.
  if (Array.isArray(ti.file_paths)) {
    for (const entry of ti.file_paths) {
      if (typeof entry === "string" && entry.length > 0) list.push(entry);
    }
  }

  // `file_path` (singular string).
  if (typeof ti.file_path === "string" && ti.file_path.length > 0) {
    if (!list.includes(ti.file_path)) list.push(ti.file_path);
  }

  return list;
}

export function parseClaudeInput(text: string): ClaudeHookInput {
  if (text.trim().length === 0) {
    return { toolName: null, files: [], hookEventName: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { toolName: null, files: [], hookEventName: null };
  }
  if (typeof raw !== "object" || raw === null) {
    return { toolName: null, files: [], hookEventName: null };
  }
  const obj = raw as RawClaudeInput;
  return {
    toolName: typeof obj.tool_name === "string" ? obj.tool_name : null,
    files: extractFiles(obj),
    hookEventName:
      typeof obj.hook_event_name === "string" ? obj.hook_event_name : null,
  };
}
