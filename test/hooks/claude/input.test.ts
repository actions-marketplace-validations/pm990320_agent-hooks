import { describe, expect, test } from "bun:test";
import { parseClaudeInput } from "../../../src/hooks/claude/input.ts";

describe("parseClaudeInput", () => {
  test("returns empty shape for empty input", () => {
    expect(parseClaudeInput("")).toEqual({
      toolName: null,
      files: [],
      hookEventName: null,
    });
  });

  test("returns empty shape for whitespace-only input", () => {
    expect(parseClaudeInput("   \n")).toEqual({
      toolName: null,
      files: [],
      hookEventName: null,
    });
  });

  test("returns empty shape for invalid JSON", () => {
    expect(parseClaudeInput("not json")).toEqual({
      toolName: null,
      files: [],
      hookEventName: null,
    });
  });

  test("returns empty shape for JSON that isn't an object", () => {
    expect(parseClaudeInput("[1,2,3]")).toEqual({
      toolName: null,
      files: [],
      hookEventName: null,
    });
    expect(parseClaudeInput("null")).toEqual({
      toolName: null,
      files: [],
      hookEventName: null,
    });
  });

  test("extracts tool name and file_paths array", () => {
    const result = parseClaudeInput(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.ts", "src/b.ts"] },
      }),
    );
    expect(result.toolName).toBe("Edit");
    expect(result.hookEventName).toBe("PostToolUse");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("falls back to file_path singular when file_paths is absent", () => {
    const result = parseClaudeInput(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "src/x.ts" },
      }),
    );
    expect(result.files).toEqual(["src/x.ts"]);
  });

  test("de-duplicates file_path when it's already in file_paths", () => {
    const result = parseClaudeInput(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "src/a.ts",
          file_paths: ["src/a.ts", "src/b.ts"],
        },
      }),
    );
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("filters out non-string entries from file_paths", () => {
    const result = parseClaudeInput(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_paths: ["ok.ts", 123, "", null, "other.ts"] },
      }),
    );
    expect(result.files).toEqual(["ok.ts", "other.ts"]);
  });

  test("returns empty files when tool_input is missing", () => {
    const result = parseClaudeInput(
      JSON.stringify({ tool_name: "Stop" }),
    );
    expect(result.files).toEqual([]);
    expect(result.toolName).toBe("Stop");
  });

  test("returns null for non-string tool_name / hook_event_name", () => {
    const result = parseClaudeInput(
      JSON.stringify({ tool_name: 5, hook_event_name: true }),
    );
    expect(result.toolName).toBeNull();
    expect(result.hookEventName).toBeNull();
  });
});
