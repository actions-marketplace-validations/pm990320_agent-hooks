import { describe, expect, test } from "bun:test";
import { configHash } from "../../../src/integrations/git/hash.ts";
import { ConfigSchema } from "../../../src/config/schema.ts";

describe("configHash", () => {
  test("is stable across invocations for the same config", () => {
    const config = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
    });
    expect(configHash(config)).toBe(configHash(config));
  });

  test("changes when the git section changes", () => {
    const a = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "a" } } },
    });
    const b = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "b" } } },
    });
    expect(configHash(a)).not.toBe(configHash(b));
  });

  test("treats missing git section as stable", () => {
    const a = ConfigSchema.parse({});
    const b = ConfigSchema.parse({});
    expect(configHash(a)).toBe(configHash(b));
  });

  test("returns a 64-character hex digest", () => {
    const config = ConfigSchema.parse({});
    expect(configHash(config)).toMatch(/^[0-9a-f]{64}$/);
  });
});
