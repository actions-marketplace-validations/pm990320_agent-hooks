import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfigSchema, type Config } from "../../../src/config/schema.ts";
import {
  defaultHookFs,
  installHooks,
  type HookFs,
} from "../../../src/integrations/git/install.ts";
import { inspectStub } from "../../../src/integrations/git/stub.ts";

// --- In-memory HookFs ---------------------------------------------------

interface MemEntry {
  contents: string;
  mode: number;
}

function memFs(): HookFs & { files: Map<string, MemEntry> } {
  const files = new Map<string, MemEntry>();
  return {
    files,
    exists(p) {
      return Promise.resolve(files.has(p));
    },
    read(p) {
      const entry = files.get(p);
      if (!entry) return Promise.reject(new Error(`ENOENT: ${p}`));
      return Promise.resolve(entry.contents);
    },
    write(p, contents, mode) {
      files.set(p, { contents, mode });
      return Promise.resolve();
    },
    mkdirRecursive(_p) {
      return Promise.resolve();
    },
    remove(p) {
      files.delete(p);
      return Promise.resolve();
    },
  };
}

function sampleConfig(): Config {
  return ConfigSchema.parse({
    git: {
      hooks: {
        "pre-commit": { pipeline: "pre-commit" },
        "pre-push": { pipeline: "pre-push" },
      },
    },
    steps: { lint: { run: "eslint" } },
    pipelines: {
      "pre-commit": { steps: ["lint"] },
      "pre-push": { steps: ["lint"] },
    },
  });
}

// --- Install semantics --------------------------------------------------

describe("installHooks — fresh install", () => {
  test("writes a stub for each configured hook", async () => {
    const fsMem = memFs();
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    expect(result.outcomes.map((o) => o.status).sort()).toEqual([
      "wrote",
      "wrote",
    ]);
    const preCommit = fsMem.files.get("/repo/.git/hooks/pre-commit");
    expect(preCommit?.contents).toContain("hook git pre-commit");
    expect(preCommit?.mode).toBe(0o755);
  });

  test("embeds the current config hash in each stub", async () => {
    const fsMem = memFs();
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    const preCommit = fsMem.files.get("/repo/.git/hooks/pre-commit")!;
    const info = inspectStub(preCommit.contents);
    expect(info.managed).toBe(true);
    expect(info.configHash).toBe(result.hash);
  });
});

describe("installHooks — idempotence", () => {
  test("second run with unchanged config produces only skipped-same-hash", async () => {
    const fsMem = memFs();
    await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    expect(result.allUpToDate).toBe(true);
    expect(result.outcomes.map((o) => o.status)).toEqual([
      "skipped-same-hash",
      "skipped-same-hash",
    ]);
  });

  test("updates a managed stub whose hash no longer matches", async () => {
    const fsMem = memFs();
    await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    // Simulate a config change by installing with a different config.
    const modified = ConfigSchema.parse({
      git: {
        hooks: {
          "pre-commit": { pipeline: "new-pre-commit" },
          "pre-push": { pipeline: "pre-push" },
        },
      },
      steps: { lint: { run: "eslint" } },
      pipelines: {
        "new-pre-commit": { steps: ["lint"] },
        "pre-push": { steps: ["lint"] },
      },
    });
    const result = await installHooks({
      gitRoot: "/repo",
      config: modified,
      fs: fsMem,
    });
    const statuses = result.outcomes.map((o) => o.status).sort();
    expect(statuses).toContain("updated");
  });
});

describe("installHooks — foreign hooks", () => {
  test("foreignHookPolicy=skip leaves user-managed hooks alone", async () => {
    const fsMem = memFs();
    fsMem.files.set("/repo/.git/hooks/pre-commit", {
      contents: "#!/bin/sh\necho user-managed\n",
      mode: 0o755,
    });
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    expect(
      result.outcomes.find((o) => o.hookName === "pre-commit")?.status,
    ).toBe("skipped-foreign");
    const preCommit = fsMem.files.get("/repo/.git/hooks/pre-commit");
    expect(preCommit?.contents).toContain("user-managed");
  });

  test("foreignHookPolicy=replace overwrites user-managed hooks", async () => {
    const fsMem = memFs();
    fsMem.files.set("/repo/.git/hooks/pre-commit", {
      contents: "#!/bin/sh\necho user-managed\n",
      mode: 0o755,
    });
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
      foreignHookPolicy: "replace",
    });
    expect(
      result.outcomes.find((o) => o.hookName === "pre-commit")?.status,
    ).toBe("replaced-foreign");
    expect(
      fsMem.files.get("/repo/.git/hooks/pre-commit")?.contents,
    ).toContain("agent-hooks managed hook");
  });
});

describe("installHooks — orphan cleanup", () => {
  test("removes managed stubs for hooks no longer in config", async () => {
    const fsMem = memFs();
    await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    // New config omits pre-push → its stub should be removed.
    const trimmed = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
      steps: { lint: { run: "eslint" } },
      pipelines: { "pre-commit": { steps: ["lint"] } },
    });
    const result = await installHooks({
      gitRoot: "/repo",
      config: trimmed,
      fs: fsMem,
    });
    const removed = result.outcomes.find(
      (o) => o.hookName === "pre-push" && o.status === "removed-stale",
    );
    expect(removed).toBeDefined();
    expect(fsMem.files.has("/repo/.git/hooks/pre-push")).toBe(false);
  });

  test("leaves foreign hooks alone during orphan cleanup", async () => {
    const fsMem = memFs();
    fsMem.files.set("/repo/.git/hooks/post-commit", {
      contents: "#!/bin/sh\necho user wrote this\n",
      mode: 0o755,
    });
    await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
    });
    expect(fsMem.files.has("/repo/.git/hooks/post-commit")).toBe(true);
  });
});

describe("installHooks — empty config + --if-missing semantics", () => {
  test("no hooks configured is a no-op", async () => {
    const fsMem = memFs();
    const config = ConfigSchema.parse({});
    const result = await installHooks({
      gitRoot: "/repo",
      config,
      fs: fsMem,
    });
    expect(result.outcomes).toEqual([]);
    expect(result.allUpToDate).toBe(true);
  });

  test("--if-missing still writes missing stubs", async () => {
    // --if-missing only short-circuits the caller after the fact; the
    // installer always brings reality in line with the config. The
    // caller is responsible for inspecting `allUpToDate` to decide
    // whether the install actually did nothing.
    const fsMem = memFs();
    const result = await installHooks({
      gitRoot: "/repo",
      config: sampleConfig(),
      fs: fsMem,
      ifMissing: true,
    });
    expect(result.outcomes.every((o) => o.status === "wrote")).toBe(true);
    expect(result.allUpToDate).toBe(false);
  });
});

// --- Real filesystem adapter --------------------------------------------

describe("defaultHookFs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-hookfs-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("exists returns false for missing paths", async () => {
    expect(await defaultHookFs.exists(path.join(tmp, "nope"))).toBe(false);
  });

  test("write + read + exists roundtrip", async () => {
    const p = path.join(tmp, "hook");
    await defaultHookFs.write(p, "contents", 0o755);
    expect(await defaultHookFs.exists(p)).toBe(true);
    expect(await defaultHookFs.read(p)).toBe("contents");
    const stat = await fs.stat(p);
    expect((stat.mode & 0o777).toString(8)).toBe("755");
  });

  test("mkdirRecursive creates nested directories", async () => {
    await defaultHookFs.mkdirRecursive(path.join(tmp, "a", "b", "c"));
    const stat = await fs.stat(path.join(tmp, "a", "b", "c"));
    expect(stat.isDirectory()).toBe(true);
  });

  test("remove deletes a file", async () => {
    const p = path.join(tmp, "x");
    await defaultHookFs.write(p, "x", 0o644);
    await defaultHookFs.remove(p);
    expect(await defaultHookFs.exists(p)).toBe(false);
  });

  test("real-world install against a tmp .git directory", async () => {
    await fs.mkdir(path.join(tmp, ".git", "hooks"), { recursive: true });
    const result = await installHooks({
      gitRoot: tmp,
      config: sampleConfig(),
      fs: defaultHookFs,
    });
    expect(result.outcomes).toHaveLength(2);
    const preCommit = await fs.readFile(
      path.join(tmp, ".git", "hooks", "pre-commit"),
      "utf8",
    );
    expect(preCommit).toContain("hook git pre-commit");
    const stat = await fs.stat(path.join(tmp, ".git", "hooks", "pre-commit"));
    expect((stat.mode & 0o100) !== 0).toBe(true); // owner-executable
  });
});
