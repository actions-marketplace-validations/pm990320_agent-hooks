import { describe, expect, test } from "bun:test";
import {
  emptyInput,
  parseClaudeStyleInput,
  parseLineDelimitedInput,
  parsePluginContextInput,
} from "../../src/hooks/parsers.ts";

describe("emptyInput", () => {
  test("has null tool + empty files + null event", () => {
    expect(emptyInput.toolName).toBeNull();
    expect(emptyInput.files).toEqual([]);
    expect(emptyInput.hookEventName).toBeNull();
  });
});

describe("parseClaudeStyleInput", () => {
  test("empty input returns emptyInput shape", () => {
    expect(parseClaudeStyleInput("")).toEqual(emptyInput);
  });

  test("invalid JSON returns emptyInput shape", () => {
    expect(parseClaudeStyleInput("not json")).toEqual(emptyInput);
  });

  test("non-object JSON (array) returns emptyInput shape", () => {
    expect(parseClaudeStyleInput("[1,2,3]")).toEqual(emptyInput);
  });

  test("JSON null returns emptyInput shape", () => {
    expect(parseClaudeStyleInput("null")).toEqual(emptyInput);
  });

  test("extracts tool_name, file_paths, hook_event_name, session_id", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        session_id: "sess-1",
        tool_input: { file_paths: ["a.ts", "b.ts"] },
      }),
    );
    expect(result.toolName).toBe("Edit");
    expect(result.hookEventName).toBe("PostToolUse");
    expect(result.sessionId).toBe("sess-1");
    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });

  test("falls back to tool_input.paths when file_paths is absent", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({
        tool_name: "Write",
        tool_input: { paths: ["p1", "p2"] },
      }),
    );
    expect(result.files).toEqual(["p1", "p2"]);
  });

  test("file_path singular is appended without duplication", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: {
          file_path: "a.ts",
          file_paths: ["a.ts", "b.ts"],
        },
      }),
    );
    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });

  test("non-string entries in file_paths are filtered", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_paths: ["ok.ts", 42, "", null, "two.ts"] },
      }),
    );
    expect(result.files).toEqual(["ok.ts", "two.ts"]);
  });

  test("missing tool_input yields empty files and captures tool_name", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({ tool_name: "Stop" }),
    );
    expect(result.files).toEqual([]);
    expect(result.toolName).toBe("Stop");
  });

  test("non-string tool_name and session_id produce null", () => {
    const result = parseClaudeStyleInput(
      JSON.stringify({ tool_name: 5, session_id: true }),
    );
    expect(result.toolName).toBeNull();
    expect(result.sessionId).toBeNull();
  });
});

describe("parseLineDelimitedInput", () => {
  test("splits on newlines, trims, drops empty lines", () => {
    const result = parseLineDelimitedInput("src/a.ts\n  src/b.ts  \n\n");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.toolName).toBeNull();
    expect(result.hookEventName).toBeNull();
  });

  test("empty input produces no files", () => {
    expect(parseLineDelimitedInput("").files).toEqual([]);
  });
});

describe("parsePluginContextInput", () => {
  test("empty input returns emptyInput", () => {
    expect(parsePluginContextInput("")).toEqual(emptyInput);
  });

  test("invalid JSON returns emptyInput", () => {
    expect(parsePluginContextInput("not json")).toEqual(emptyInput);
  });

  test("non-object JSON returns emptyInput", () => {
    expect(parsePluginContextInput('"string"')).toEqual(emptyInput);
  });

  test("extracts event, tool, files, session", () => {
    const result = parsePluginContextInput(
      JSON.stringify({
        event: "PostToolUse",
        tool: "Edit",
        files: ["a.ts", "b.ts"],
        session: "s-1",
      }),
    );
    expect(result.hookEventName).toBe("PostToolUse");
    expect(result.toolName).toBe("Edit");
    expect(result.files).toEqual(["a.ts", "b.ts"]);
    expect(result.sessionId).toBe("s-1");
  });

  test("filters non-string file entries", () => {
    const result = parsePluginContextInput(
      JSON.stringify({
        event: "e",
        files: ["ok.ts", 5, null, "two.ts"],
      }),
    );
    expect(result.files).toEqual(["ok.ts", "two.ts"]);
  });

  test("missing files array yields empty files", () => {
    const result = parsePluginContextInput(
      JSON.stringify({ event: "PostToolUse" }),
    );
    expect(result.files).toEqual([]);
  });

  test("non-string event/tool/session produce null", () => {
    const result = parsePluginContextInput(
      JSON.stringify({ event: 1, tool: [], session: null }),
    );
    expect(result.hookEventName).toBeNull();
    expect(result.toolName).toBeNull();
    expect(result.sessionId).toBeNull();
  });
});
