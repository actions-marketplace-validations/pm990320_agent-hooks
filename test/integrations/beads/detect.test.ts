import { describe, expect, test } from "bun:test";
import {
  detectBeads,
  type BeadsFs,
} from "../../../src/integrations/beads/detect.ts";

function fs(exists: boolean): BeadsFs {
  return {
    exists: () => Promise.resolve(exists),
  };
}

describe("detectBeads", () => {
  test("config enabled: false short-circuits to disabled", async () => {
    const result = await detectBeads("/repo", false, fs(true));
    expect(result.enabled).toBe(false);
    expect(result.beadsDir).toBeNull();
  });

  test("config enabled: true short-circuits to enabled with path", async () => {
    const result = await detectBeads("/repo", true, fs(false));
    expect(result.enabled).toBe(true);
    expect(result.beadsDir).toBe("/repo/.beads");
  });

  test("auto + .beads present → enabled", async () => {
    const result = await detectBeads("/repo", "auto", fs(true));
    expect(result.enabled).toBe(true);
    expect(result.beadsDir).toBe("/repo/.beads");
  });

  test("auto + .beads absent → disabled", async () => {
    const result = await detectBeads("/repo", "auto", fs(false));
    expect(result.enabled).toBe(false);
    expect(result.beadsDir).toBeNull();
  });

  test("undefined config falls through to auto semantics", async () => {
    const result = await detectBeads("/repo", undefined, fs(true));
    expect(result.enabled).toBe(true);
  });
});
