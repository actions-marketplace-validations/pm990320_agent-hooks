import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  defaultSchemaDeps,
  registerSchemaCommand,
} from "../../src/commands/schema.ts";

describe("registerSchemaCommand", () => {
  test("registers a `schema` subcommand", () => {
    const program = new Command().exitOverride();
    registerSchemaCommand(program, { write: () => {} });
    const cmd = program.commands.find((c) => c.name() === "schema");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("JSON Schema");
  });

  test("action writes the rendered schema via the injected writer", async () => {
    const program = new Command().exitOverride();
    let captured = "";
    registerSchemaCommand(program, {
      write: (text) => {
        captured += text;
      },
    });
    await program.parseAsync(["schema"], { from: "user" });
    expect(captured.length).toBeGreaterThan(0);
    const parsed = JSON.parse(captured) as Record<string, unknown>;
    expect(parsed["$schema"]).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  test("defaultSchemaDeps.write forwards to process.stdout", () => {
    // Cover the default writer without polluting test output.
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      defaultSchemaDeps.write("hello");
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toBe("hello");
  });

  test("registerSchemaCommand defaults to the built-in deps when none passed", () => {
    const program = new Command().exitOverride();
    const cmd = registerSchemaCommand(program);
    expect(cmd).toBeDefined();
  });
});
