import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../../src/config/schema.ts";
import {
  dispatchGitHook,
  scopeForGitHook,
} from "../../../src/hooks/git/dispatch.ts";
import type { GitRunner } from "../../../src/runners/files.ts";
import type { ExecFn, ExecInput } from "../../../src/runners/step.ts";
import type { Reporter } from "../../../src/reporters/index.ts";

function stubGit(files: readonly string[] = []): GitRunner {
  return {
    staged: () => Promise.resolve(files),
    changed: () => Promise.resolve(files),
    all: () => Promise.resolve(files),
  };
}

function captureReporter(): Reporter & { events: string[] } {
  const events: string[] = [];
  const reporter: Reporter = {
    pipelineStart: (name) => events.push(`pipelineStart:${name}`),
    stepStart: (info) => events.push(`stepStart:${info.name}`),
    stepEnd: (outcome) => events.push(`stepEnd:${outcome.name}`),
    pipelineEnd: (result) =>
      events.push(`pipelineEnd:${result.pipelineName}:${String(result.ok)}`),
  };
  return Object.assign(reporter, { events });
}

describe("scopeForGitHook", () => {
  test("pre-commit → staged", () => {
    expect(scopeForGitHook("pre-commit")).toBe("staged");
  });

  test("prepare-commit-msg and commit-msg → staged", () => {
    expect(scopeForGitHook("prepare-commit-msg")).toBe("staged");
    expect(scopeForGitHook("commit-msg")).toBe("staged");
  });

  test("pre-push / post-merge / post-checkout / post-rewrite → changed", () => {
    expect(scopeForGitHook("pre-push")).toBe("changed");
    expect(scopeForGitHook("post-merge")).toBe("changed");
    expect(scopeForGitHook("post-checkout")).toBe("changed");
    expect(scopeForGitHook("post-rewrite")).toBe("changed");
  });

  test("unknown hook names → all", () => {
    expect(scopeForGitHook("pre-auto-gc")).toBe("all");
  });
});

describe("dispatchGitHook", () => {
  function sampleConfig() {
    return ConfigSchema.parse({
      steps: {
        lint: { run: "echo lint {files}", files: "**/*.ts" },
        typecheck: { run: "echo tsc", invocation: "project" },
      },
      pipelines: {
        "pre-commit": { steps: ["lint", "typecheck"] },
      },
      git: {
        hooks: {
          "pre-commit": { pipeline: "pre-commit" },
        },
      },
    });
  }

  function sampleExec(exit = 0): { exec: ExecFn; calls: ExecInput[] } {
    const calls: ExecInput[] = [];
    const exec: ExecFn = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: exit, durationMs: 1 });
    };
    return { exec, calls };
  }

  test("returns no-rule when the hook is not configured", async () => {
    const config = ConfigSchema.parse({});
    const reporter = captureReporter();
    const { exec } = sampleExec();
    const result = await dispatchGitHook({
      hookName: "pre-commit",
      config,
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.status).toBe("no-rule");
    expect(result.exitCode).toBe(0);
    expect(reporter.events).toEqual([]);
  });

  test("returns pipeline-missing when the rule references a missing pipeline", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { ci: { steps: ["lint"] } },
      git: {
        hooks: { "pre-commit": { pipeline: "does-not-exist" } },
      },
    });
    const reporter = captureReporter();
    const { exec } = sampleExec();
    const result = await dispatchGitHook({
      hookName: "pre-commit",
      config,
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.status).toBe("pipeline-missing");
    expect(result.exitCode).toBe(2);
  });

  test("runs the configured pipeline and passes the staged scope files", async () => {
    const reporter = captureReporter();
    const { exec, calls } = sampleExec();
    const result = await dispatchGitHook({
      hookName: "pre-commit",
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(["src/a.ts", "src/b.ts"]),
      exec,
      reporter,
    });
    expect(result.status).toBe("ran");
    expect(result.exitCode).toBe(0);
    expect(calls.some((c) => c.command.includes("src/a.ts"))).toBe(true);
    expect(reporter.events).toContain("pipelineStart:pre-commit");
    expect(reporter.events).toContain("pipelineEnd:pre-commit:true");
  });

  test("propagates pipeline failure exit code", async () => {
    const reporter = captureReporter();
    const { exec } = sampleExec(3);
    const result = await dispatchGitHook({
      hookName: "pre-commit",
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(["src/a.ts"]),
      exec,
      reporter,
    });
    expect(result.status).toBe("ran");
    expect(result.exitCode).toBe(3);
  });

  test("pre-commit auto-stages .beads/* changes when configured", async () => {
    const stages: string[][] = [];
    const git: GitRunner = {
      staged: () => Promise.resolve(["src/a.ts"]),
      changed: () => Promise.resolve([]),
      all: () => Promise.resolve([]),
      modifiedUnder: () => Promise.resolve([".beads/db.json"]),
      stage: (paths) => {
        stages.push([...paths]);
        return Promise.resolve();
      },
    };
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "pre-commit": { steps: ["lint"] } },
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
      beads: { enabled: true, "pre-commit": "stage" },
    });
    const reporter = captureReporter();
    const { exec } = sampleExec();
    let out = "";
    const result = await dispatchGitHook({
      hookName: "pre-commit",
      config,
      cwd: "/repo",
      env: {},
      git,
      exec,
      reporter,
      write: (t) => {
        out += t;
      },
      beadsFs: { exists: () => Promise.resolve(true) },
    });
    expect(result.status).toBe("ran");
    expect(result.beads?.action).toBe("staged");
    expect(stages).toEqual([[".beads/db.json"]]);
    expect(out).toContain("staged 1 .beads");
  });

  test("post-commit hooks don't run the beads stager", async () => {
    const stages: string[][] = [];
    const git: GitRunner = {
      staged: () => Promise.resolve([]),
      changed: () => Promise.resolve([]),
      all: () => Promise.resolve([]),
      modifiedUnder: () => Promise.resolve([".beads/db.json"]),
      stage: (paths) => {
        stages.push([...paths]);
        return Promise.resolve();
      },
    };
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "post-merge": { steps: ["lint"] } },
      git: { hooks: { "post-merge": { pipeline: "post-merge" } } },
      beads: { enabled: true, "pre-commit": "stage" },
    });
    const reporter = captureReporter();
    const { exec } = sampleExec();
    const result = await dispatchGitHook({
      hookName: "post-merge",
      config,
      cwd: "/repo",
      env: {},
      git,
      exec,
      reporter,
      beadsFs: { exists: () => Promise.resolve(true) },
    });
    expect(result.status).toBe("ran");
    expect(result.beads).toBeUndefined();
    expect(stages).toEqual([]);
  });
});
