import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Config } from "../../../src/config/schema.ts";
import type { BeadsFs } from "../../../src/integrations/beads/detect.ts";
import { autoStageBeadsChanges } from "../../../src/integrations/beads/pre-commit.ts";
import type { GitRunner } from "../../../src/runners/files.ts";

interface FakeGitOptions {
  readonly modified?: readonly string[];
  readonly recordStages?: string[][];
  readonly omitModified?: boolean;
  readonly omitStage?: boolean;
}

function fakeGit(opts: FakeGitOptions = {}): GitRunner {
  const runner: GitRunner = {
    staged: () => Promise.resolve([]),
    changed: () => Promise.resolve([]),
    all: () => Promise.resolve([]),
  };
  if (!opts.omitModified) {
    runner.modifiedUnder = () => Promise.resolve(opts.modified ?? []);
  }
  if (!opts.omitStage) {
    runner.stage = (paths) => {
      if (opts.recordStages) opts.recordStages.push([...paths]);
      return Promise.resolve();
    };
  }
  return runner;
}

function memFs(presentPaths: readonly string[]): BeadsFs {
  const set = new Set(presentPaths);
  return { exists: (p) => Promise.resolve(set.has(p)) };
}

function configWith(
  overrides: {
    mode?: "stage" | "warn" | "off";
    enabled?: "auto" | boolean;
  } = {},
): Config {
  return ConfigSchema.parse({
    steps: { lint: { run: "echo" } },
    pipelines: { "pre-commit": { steps: ["lint"] } },
    beads: {
      enabled: overrides.enabled ?? "auto",
      ...(overrides.mode ? { "pre-commit": overrides.mode } : {}),
    },
  });
}

describe("autoStageBeadsChanges", () => {
  test("noop when beads is not enabled (no .beads/ dir)", async () => {
    const stages: string[][] = [];
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith(),
      git: fakeGit({ modified: ["a"], recordStages: stages }),
      fs: memFs([]),
      write: () => {},
    });
    expect(outcome.action).toBe("noop");
    expect(stages).toEqual([]);
  });

  test("noop when config sets beads.pre-commit: off", async () => {
    const stages: string[][] = [];
    let out = "";
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith({ mode: "off" }),
      git: fakeGit({
        modified: [".beads/db.json"],
        recordStages: stages,
      }),
      fs: memFs(["/repo/.beads"]),
      write: (t) => {
        out += t;
      },
    });
    expect(outcome.action).toBe("noop");
    expect(stages).toEqual([]);
    expect(out).toBe("");
  });

  test("noop when nothing under .beads/ has changed", async () => {
    const stages: string[][] = [];
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith(),
      git: fakeGit({ modified: [], recordStages: stages }),
      fs: memFs(["/repo/.beads"]),
      write: () => {},
    });
    expect(outcome.action).toBe("noop");
    expect(stages).toEqual([]);
  });

  test("stage mode: adds modified .beads files and logs a count", async () => {
    const stages: string[][] = [];
    let out = "";
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith({ mode: "stage" }),
      git: fakeGit({
        modified: [".beads/db.json", ".beads/issues/abc.md"],
        recordStages: stages,
      }),
      fs: memFs(["/repo/.beads"]),
      write: (t) => {
        out += t;
      },
    });
    expect(outcome.action).toBe("staged");
    expect(outcome.files).toEqual([
      ".beads/db.json",
      ".beads/issues/abc.md",
    ]);
    expect(stages).toEqual([[".beads/db.json", ".beads/issues/abc.md"]]);
    expect(out).toContain("staged 2 .beads");
  });

  test("warn mode: logs but doesn't touch the index", async () => {
    const stages: string[][] = [];
    let out = "";
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith({ mode: "warn" }),
      git: fakeGit({
        modified: [".beads/db.json"],
        recordStages: stages,
      }),
      fs: memFs(["/repo/.beads"]),
      write: (t) => {
        out += t;
      },
    });
    expect(outcome.action).toBe("warned");
    expect(stages).toEqual([]);
    expect(out).toContain("unstaged");
  });

  test("default mode is stage when beads.pre-commit is omitted", async () => {
    const stages: string[][] = [];
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith(),
      git: fakeGit({
        modified: [".beads/db.json"],
        recordStages: stages,
      }),
      fs: memFs(["/repo/.beads"]),
      write: () => {},
    });
    expect(outcome.action).toBe("staged");
  });

  test("noop when the GitRunner doesn't expose modifiedUnder", async () => {
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith(),
      git: fakeGit({ omitModified: true }),
      fs: memFs(["/repo/.beads"]),
      write: () => {},
    });
    expect(outcome.action).toBe("noop");
  });

  test("stage mode falls back to warn when the runner has modifiedUnder but no stage()", async () => {
    let out = "";
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith({ mode: "stage" }),
      git: fakeGit({
        modified: [".beads/db.json"],
        omitStage: true,
      }),
      fs: memFs(["/repo/.beads"]),
      write: (t) => {
        out += t;
      },
    });
    expect(outcome.action).toBe("warned");
    expect(out).toContain("would stage");
  });

  test("honors beads.enabled: false even when .beads/ exists", async () => {
    const outcome = await autoStageBeadsChanges({
      cwd: "/repo",
      config: configWith({ enabled: false }),
      git: fakeGit({ modified: [".beads/db.json"] }),
      fs: memFs(["/repo/.beads"]),
      write: () => {},
    });
    expect(outcome.action).toBe("noop");
  });
});
