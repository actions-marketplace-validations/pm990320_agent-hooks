import { describe, expect, test } from "bun:test";
import { StepSchema, type Step } from "../../src/config/schema.ts";
import {
  evaluateGate,
  recordGateRun,
  type GateCacheFs,
} from "../../src/runners/change-gates.ts";
import type { GitRunner } from "../../src/runners/files.ts";

function stubGit(
  staged: readonly string[],
  changed: readonly string[],
): GitRunner {
  return {
    staged: () => Promise.resolve(staged),
    changed: () => Promise.resolve(changed),
    all: () => Promise.resolve([]),
  };
}

function step(overrides: unknown): Step {
  return StepSchema.parse({
    run: "echo",
    ...(overrides as Record<string, unknown>),
  });
}

describe("evaluateGate", () => {
  test("returns null when step has no when-changed block", async () => {
    const result = await evaluateGate(step({}), stubGit([], []));
    expect(result).toBeNull();
  });

  test("returns shouldRun=true when a staged file matches the watch glob", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "head" },
    });
    const result = await evaluateGate(
      s,
      stubGit(["package.json"], []),
    );
    expect(result?.shouldRun).toBe(true);
  });

  test("returns shouldRun=false when no paths match", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "head" },
    });
    const result = await evaluateGate(
      s,
      stubGit(["src/a.ts"], []),
    );
    expect(result?.shouldRun).toBe(false);
    expect(result?.reason).toContain("package.json");
  });

  test("since: head unions staged and unstaged changes", async () => {
    const s = step({
      "when-changed": { paths: "*.lockb", since: "head" },
    });
    const result = await evaluateGate(
      s,
      stubGit([], ["bun.lockb"]),
    );
    expect(result?.shouldRun).toBe(true);
  });

  test("since: merge-base uses only git.changed()", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "merge-base" },
    });
    // Staged has a match but changed doesn't — since merge-base uses
    // changed() only, the gate should NOT fire.
    const result = await evaluateGate(
      s,
      stubGit(["package.json"], []),
    );
    expect(result?.shouldRun).toBe(false);
  });

  test("accepts an array of watch paths", async () => {
    const s = step({
      "when-changed": {
        paths: ["package.json", "bun.lockb"],
        since: "head",
      },
    });
    const result = await evaluateGate(
      s,
      stubGit(["bun.lockb"], []),
    );
    expect(result?.shouldRun).toBe(true);
  });

  test("glob matchers support **/* patterns", async () => {
    const s = step({
      "when-changed": { paths: "src/**/*.ts", since: "head" },
    });
    const result = await evaluateGate(
      s,
      stubGit(["src/nested/deep/file.ts"], []),
    );
    expect(result?.shouldRun).toBe(true);
  });
});

describe("evaluateGate — last-run cache", () => {
  function memCacheFs(): GateCacheFs & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      exists: (p) => Promise.resolve(files.has(p)),
      read: (p) => {
        const v = files.get(p);
        if (v === undefined) return Promise.reject(new Error("ENOENT"));
        return Promise.resolve(v);
      },
      write: (p, contents) => {
        files.set(p, contents);
        return Promise.resolve();
      },
      mkdirRecursive: () => Promise.resolve(),
    };
  }

  test("first invocation with no cache file runs the step", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "last-run" },
    });
    const cacheFs = memCacheFs();
    const result = await evaluateGate({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve('{"name":"x"}'),
    });
    expect(result?.shouldRun).toBe(true);
    expect(result?.reason).toContain("last-run hash");
  });

  test("second invocation with unchanged content skips", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "last-run" },
    });
    const cacheFs = memCacheFs();
    // Prime the cache by recording a run.
    const readContent = (): Promise<string> =>
      Promise.resolve('{"name":"x"}');
    await recordGateRun({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: readContent,
    });
    // Now re-evaluate with the same content.
    const result = await evaluateGate({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: readContent,
    });
    expect(result?.shouldRun).toBe(false);
    expect(result?.reason).toContain("unchanged");
  });

  test("re-runs when the watched file content changes", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "last-run" },
    });
    const cacheFs = memCacheFs();
    await recordGateRun({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve('{"name":"x"}'),
    });
    const result = await evaluateGate({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve('{"name":"y"}'),
    });
    expect(result?.shouldRun).toBe(true);
  });

  test("handles missing watched files (content = null)", async () => {
    const s = step({
      "when-changed": {
        paths: ["a", "b"],
        since: "last-run",
      },
    });
    const cacheFs = memCacheFs();
    const result = await evaluateGate({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve(null),
    });
    expect(result?.shouldRun).toBe(true);
  });

  test("last-run without cacheFs runs conservatively", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "last-run" },
    });
    const result = await evaluateGate({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
    });
    expect(result?.shouldRun).toBe(true);
    expect(result?.reason).toContain("cache not available");
  });
});

describe("recordGateRun", () => {
  function memCacheFs(): GateCacheFs & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      exists: (p) => Promise.resolve(files.has(p)),
      read: (p) => Promise.resolve(files.get(p) ?? ""),
      write: (p, c) => {
        files.set(p, c);
        return Promise.resolve();
      },
      mkdirRecursive: () => Promise.resolve(),
    };
  }

  test("writes a cache file for last-run gates", async () => {
    const s = step({
      "when-changed": { paths: "package.json", since: "last-run" },
    });
    const cacheFs = memCacheFs();
    await recordGateRun({
      stepName: "audit",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve("content"),
    });
    expect(cacheFs.files.has("/repo/.agent-hooks/state/audit.hash")).toBe(true);
  });

  test("no-op for non-gated steps", async () => {
    const s = step({});
    const cacheFs = memCacheFs();
    await recordGateRun({
      stepName: "x",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve(""),
    });
    expect(cacheFs.files.size).toBe(0);
  });

  test("no-op for since: head gates (only last-run uses the cache)", async () => {
    const s = step({
      "when-changed": { paths: "x", since: "head" },
    });
    const cacheFs = memCacheFs();
    await recordGateRun({
      stepName: "x",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
      cacheFs,
      readWatchPath: () => Promise.resolve(""),
    });
    expect(cacheFs.files.size).toBe(0);
  });

  test("no-op when cacheFs is omitted", async () => {
    const s = step({
      "when-changed": { paths: "x", since: "last-run" },
    });
    await recordGateRun({
      stepName: "x",
      step: s,
      git: stubGit([], []),
      cwd: "/repo",
    });
    // If it didn't throw, we're good.
    expect(true).toBe(true);
  });
});
