import { describe, expect, test } from "bun:test";
import {
  generateConfigJSONSchema,
  renderConfigJSONSchema,
} from "../../src/config/to-json-schema.ts";

describe("generateConfigJSONSchema", () => {
  test("emits a JSON Schema object for the root config", () => {
    const schema = generateConfigJSONSchema();
    expect(schema["type"]).toBe("object");
    expect(typeof schema["properties"]).toBe("object");
  });

  test("targets draft 2020-12 so VS Code picks it up", () => {
    const schema = generateConfigJSONSchema();
    expect(schema["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("includes top-level keys from PLAN §3", () => {
    const schema = generateConfigJSONSchema();
    const props = schema["properties"] as Record<string, unknown>;
    for (const key of ["steps", "pipelines", "agents", "beads", "install"]) {
      expect(props[key]).toBeDefined();
    }
  });

  test("prohibits additional root properties (strict)", () => {
    const schema = generateConfigJSONSchema();
    expect(schema["additionalProperties"]).toBe(false);
  });
});

describe("renderConfigJSONSchema", () => {
  test("returns valid, re-parseable JSON ending in a newline", () => {
    const text = renderConfigJSONSchema();
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["type"]).toBe("object");
  });

  test("is indented with 2 spaces", () => {
    const text = renderConfigJSONSchema();
    expect(text).toContain('\n  "type": "object"');
  });
});
