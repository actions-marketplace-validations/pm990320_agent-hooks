import { describe, expect, test } from "bun:test";
import { StepSchema, type Step } from "../../src/config/schema.ts";
import { resolveAreas } from "../../src/runners/areas.ts";

function step(overrides: unknown): Step {
  return StepSchema.parse({
    run: "echo",
    ...(overrides as Record<string, unknown>),
  });
}

describe("resolveAreas", () => {
  test("returns null for a step with no areas block", () => {
    expect(resolveAreas(step({}), ["a.ts"])).toBeNull();
  });

  test("returns null for an empty areas block", () => {
    expect(resolveAreas(step({ areas: {} }), ["a.ts"])).toBeNull();
  });

  test("matches a single area and rewrites to its run selectors", () => {
    const decision = resolveAreas(
      step({
        areas: {
          schemas: { when: "schemas/**", run: ["api/", "workers/"] },
        },
      }),
      ["schemas/user.json"],
    );
    expect(decision?.kind).toBe("rewrite");
    expect(decision?.files).toEqual(["api/", "workers/"]);
    expect(decision?.matchedAreas).toEqual(["schemas"]);
  });

  test("string-form when/run normalizes to arrays", () => {
    const decision = resolveAreas(
      step({ areas: { web: { when: "web/**", run: "web/" } } }),
      ["web/app.tsx"],
    );
    expect(decision?.files).toEqual(["web/"]);
  });

  test("unions run selectors from multiple matched areas, deduped", () => {
    const decision = resolveAreas(
      step({
        areas: {
          schemas: { when: "schemas/**", run: ["api/", "shared/"] },
          shared: { when: "shared/**", run: ["shared/", "docs/"] },
        },
      }),
      ["schemas/x.json", "shared/y.ts"],
    );
    expect(decision?.kind).toBe("rewrite");
    expect(decision?.matchedAreas).toEqual(["schemas", "shared"]);
    // deduped union, order preserved
    expect(decision?.files).toEqual(["api/", "shared/", "docs/"]);
  });

  test("array-form when matches if any glob hits", () => {
    const decision = resolveAreas(
      step({
        areas: {
          backend: { when: ["api/**", "workers/**"], run: "backend/" },
        },
      }),
      ["workers/queue.ts"],
    );
    expect(decision?.matchedAreas).toEqual(["backend"]);
  });

  test("unmatched: skip (default) returns a skip decision", () => {
    const decision = resolveAreas(
      step({ areas: { web: { when: "web/**", run: "web/" } } }),
      ["api/user.ts"],
    );
    expect(decision?.kind).toBe("skip");
    expect(decision?.reason).toContain("no areas matched");
  });

  test("unmatched: all returns a project decision", () => {
    const decision = resolveAreas(
      step({
        unmatched: "all",
        areas: { web: { when: "web/**", run: "web/" } },
      }),
      ["api/user.ts"],
    );
    expect(decision?.kind).toBe("project");
  });

  test("unmatched: smoke uses the smoke area's run selectors", () => {
    const decision = resolveAreas(
      step({
        unmatched: "smoke",
        areas: {
          web: { when: "web/**", run: "web/" },
          smoke: { when: "nothing/**", run: ["tests/smoke/"] },
        },
      }),
      ["api/user.ts"],
    );
    expect(decision?.kind).toBe("rewrite");
    expect(decision?.files).toEqual(["tests/smoke/"]);
    expect(decision?.matchedAreas).toEqual(["smoke"]);
  });

  test("unmatched: smoke with no smoke area falls back to skip", () => {
    const decision = resolveAreas(
      step({
        unmatched: "smoke",
        areas: { web: { when: "web/**", run: "web/" } },
      }),
      ["api/user.ts"],
    );
    expect(decision?.kind).toBe("skip");
    expect(decision?.reason).toContain("no");
  });

  test("empty file list yields a no-area-matched decision", () => {
    const decision = resolveAreas(
      step({ areas: { web: { when: "web/**", run: "web/" } } }),
      [],
    );
    expect(decision?.kind).toBe("skip");
  });

  test("preserves insertion order when multiple areas match", () => {
    const decision = resolveAreas(
      step({
        areas: {
          first: { when: "a/**", run: "out-a/" },
          second: { when: "b/**", run: "out-b/" },
        },
      }),
      ["b/x.ts", "a/x.ts"],
    );
    expect(decision?.matchedAreas).toEqual(["first", "second"]);
  });
});
