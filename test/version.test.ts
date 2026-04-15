import { describe, expect, test } from "bun:test";
import { NAME, VERSION } from "../src/version.ts";

describe("version", () => {
  test("NAME is agent-hooks", () => {
    expect(NAME).toBe("agent-hooks");
  });

  test("VERSION is a non-empty string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
