import { describe, expect, test } from "bun:test";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";

describe("ConfigError", () => {
  test("defaults path and details to null", () => {
    const err = new ConfigError("oops");
    expect(err.message).toBe("oops");
    expect(err.path).toBeNull();
    expect(err.details).toBeNull();
    expect(err.name).toBe("ConfigError");
  });

  test("captures path and details when provided", () => {
    const err = new ConfigError("boom", {
      path: "/a/b.yml",
      details: "line 3",
    });
    expect(err.path).toBe("/a/b.yml");
    expect(err.details).toBe("line 3");
  });

  test("is an Error subclass", () => {
    expect(new ConfigError("x") instanceof Error).toBe(true);
  });
});

describe("ConfigNotFoundError", () => {
  test("formats a readable search list and exposes searched[]", () => {
    const err = new ConfigNotFoundError("/repo", [
      "/repo/.config/agent-hooks.yml",
      "/repo/agent-hooks.yml",
    ]);
    expect(err.message).toContain("/repo");
    expect(err.details).toContain(".config/agent-hooks.yml");
    expect(err.searched).toHaveLength(2);
    expect(err.name).toBe("ConfigNotFoundError");
    expect(err instanceof ConfigError).toBe(true);
  });
});
