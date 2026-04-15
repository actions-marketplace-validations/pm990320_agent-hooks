import type { NormalizedHookInput } from "./types.ts";

/** Shared empty shape so parsers can bail on invalid input. */
export const emptyInput: NormalizedHookInput = {
  toolName: null,
  files: [],
  hookEventName: null,
};

/**
 * Parse a Claude-Code-style hook payload — the shape most terminal
 * coding agents adopt. Fields:
 *   - tool_name: string
 *   - hook_event_name: string
 *   - tool_input.file_path | tool_input.file_paths[] (+ various other names)
 *   - session_id: string
 *
 * Any non-string values, missing fields, or invalid JSON produce a
 * safe empty shape rather than throwing.
 */
export function parseClaudeStyleInput(text: string): NormalizedHookInput {
  if (text.trim().length === 0) return emptyInput;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyInput;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return emptyInput;
  }

  const obj = raw as {
    hook_event_name?: unknown;
    tool_name?: unknown;
    session_id?: unknown;
    tool_input?: {
      file_path?: unknown;
      file_paths?: unknown;
      paths?: unknown;
    };
  };

  const files: string[] = [];
  const ti = obj.tool_input ?? {};

  function pushIfPath(v: unknown): void {
    if (typeof v === "string" && v.length > 0 && !files.includes(v)) {
      files.push(v);
    }
  }

  if (Array.isArray(ti.file_paths)) {
    for (const entry of ti.file_paths) pushIfPath(entry);
  }
  if (Array.isArray(ti.paths)) {
    for (const entry of ti.paths) pushIfPath(entry);
  }
  if (typeof ti.file_path === "string") pushIfPath(ti.file_path);

  return {
    toolName: typeof obj.tool_name === "string" ? obj.tool_name : null,
    files,
    hookEventName:
      typeof obj.hook_event_name === "string" ? obj.hook_event_name : null,
    sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
  };
}

/**
 * Parse a generic shell-wrapper payload: file paths on stdin, one per
 * line. Used by agents with no native hook API — the `agent install
 * generic` shell stub shape.
 */
export function parseLineDelimitedInput(text: string): NormalizedHookInput {
  const files = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return {
    toolName: null,
    files,
    hookEventName: null,
  };
}

/**
 * Parse a plugin-context JSON payload with `event` + `files` at the
 * top level. Used by plugin-SDK agents (OpenCode, Qoder) that call a
 * wrapper which serializes their plugin context.
 */
export function parsePluginContextInput(text: string): NormalizedHookInput {
  if (text.trim().length === 0) return emptyInput;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyInput;
  }
  if (typeof raw !== "object" || raw === null) return emptyInput;
  const obj = raw as {
    event?: unknown;
    tool?: unknown;
    files?: unknown;
    session?: unknown;
  };
  const files: string[] = [];
  if (Array.isArray(obj.files)) {
    for (const entry of obj.files) {
      if (typeof entry === "string" && entry.length > 0) files.push(entry);
    }
  }
  return {
    toolName: typeof obj.tool === "string" ? obj.tool : null,
    files,
    hookEventName: typeof obj.event === "string" ? obj.event : null,
    sessionId: typeof obj.session === "string" ? obj.session : null,
  };
}
