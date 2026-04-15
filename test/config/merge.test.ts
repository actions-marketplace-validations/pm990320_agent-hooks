import { describe, expect, test } from "bun:test";
import { deepMerge } from "../../src/config/merge.ts";

describe("deepMerge", () => {
  test("returns base unchanged when override is undefined", () => {
    const base = { a: 1 };
    expect(deepMerge(base, undefined)).toEqual({ a: 1 });
  });

  test("returns override when base is not a plain object", () => {
    expect(deepMerge(5 as unknown, { x: 1 })).toEqual({ x: 1 });
  });

  test("returns override when override is a non-object primitive", () => {
    expect(deepMerge({ a: 1 }, 42)).toBe(42);
  });

  test("merges two flat objects with override winning", () => {
    expect(deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({
      a: 1,
      b: 3,
      c: 4,
    });
  });

  test("recursively merges nested objects", () => {
    const result = deepMerge(
      { steps: { lint: { run: "eslint", files: "**/*.ts" } } },
      { steps: { lint: { run: "eslint --cache" } } },
    );
    expect(result).toEqual({
      steps: { lint: { run: "eslint --cache", files: "**/*.ts" } },
    });
  });

  test("replaces arrays wholesale, does not concatenate", () => {
    const result = deepMerge(
      { pipelines: { ci: { steps: ["lint", "test"] } } },
      { pipelines: { ci: { steps: ["build"] } } },
    );
    expect(result).toEqual({
      pipelines: { ci: { steps: ["build"] } },
    });
  });

  test("treats null as an override value", () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null });
  });

  test("replaces object with primitive", () => {
    expect(deepMerge({ a: { b: 1 } }, { a: "x" })).toEqual({ a: "x" });
  });

  test("returns override when base is null", () => {
    expect(deepMerge(null, { a: 1 })).toEqual({ a: 1 });
  });

  test("handles objects with null prototype", () => {
    const base = Object.create(null) as Record<string, unknown>;
    base["a"] = 1;
    const result = deepMerge(base, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });
});
