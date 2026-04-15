import { z } from "zod";
import { ConfigSchema } from "./schema.ts";

/**
 * Generate the JSON Schema for the agent-hooks config. Thin wrapper around
 * zod's built-in `toJSONSchema` so callers (the build script, the
 * `agent-hooks schema` command, tests) can share one source of truth.
 */
export function generateConfigJSONSchema(): Record<string, unknown> {
  return z.toJSONSchema(ConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
}

/**
 * Stable, indented JSON text for the config schema. Used by the build
 * script to write `schema.json` and by the `schema` command to print to
 * stdout. Trailing newline for POSIX friendliness.
 */
export function renderConfigJSONSchema(): string {
  return `${JSON.stringify(generateConfigJSONSchema(), null, 2)}\n`;
}
