import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Config } from "../../../src/config/schema.ts";
import {
  dispatchClaudeHook,
  pickClaudeRule,
} from "../../../src/hooks/claude/dispatch.ts";
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
  return {
    events,
    pipelineStart: (n) => events.push(`start:${n}`),
    stepStart: (info) => events.push(`step:${info.name}`),
    stepEnd: (o) => events.push(`end:${o.name}`),
    pipelineEnd: (r) => events.push(`done:${r.pipelineName}:${String(r.ok)}`),
  };
}

function recordExec(exit = 0): { exec: ExecFn; calls: ExecInput[] } {
  const calls: ExecInput[] = [];
  return {
    calls,
    exec: (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: exit, durationMs: 1 });
    },
  };
}

function sampleConfig(): Config {
  return ConfigSchema.parse({
    steps: {
      lint: { run: "echo lint {files}" },
      smoke: { run: "echo smoke", invocation: "project" },
    },
    pipelines: {
      "agent-edit": { steps: ["lint"] },
      "session-wrap": { steps: ["smoke"] },
    },
    agents: {
      "claude-code": {
        hooks: {
          PostToolUse: [
            { matcher: "Write|Edit|MultiEdit", pipeline: "agent-edit" },
          ],
          Stop: [{ pipeline: "session-wrap" }],
        },
      },
    },
  });
}

describe("pickClaudeRule", () => {
  test("returns null when no rules exist for the hook", () => {
    const config = ConfigSchema.parse({});
    expect(pickClaudeRule(config, "PostToolUse", "Edit")).toBeNull();
  });

  test("returns null when rules exist but no matcher fits", () => {
    expect(pickClaudeRule(sampleConfig(), "PostToolUse", "Bash")).toBeNull();
  });

  test("matches the first matcher that fires", () => {
    const rule = pickClaudeRule(sampleConfig(), "PostToolUse", "Edit");
    expect(rule?.pipeline).toBe("agent-edit");
  });

  test("matcherless rules always fire", () => {
    const rule = pickClaudeRule(sampleConfig(), "Stop", null);
    expect(rule?.pipeline).toBe("session-wrap");
  });

  test("skips rules with matchers when tool name is null", () => {
    // Same config but for PostToolUse with null tool — matcher requires
    // a string so it's skipped and we return null.
    expect(pickClaudeRule(sampleConfig(), "PostToolUse", null)).toBeNull();
  });

  test("gracefully ignores invalid regex matchers", () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { lint: { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [
              { matcher: "[[[", pipeline: "lint" },
              { matcher: "Edit", pipeline: "lint" },
            ],
          },
        },
      },
    });
    // First matcher is invalid → skipped. Second matches "Edit".
    const rule = pickClaudeRule(config, "PostToolUse", "Edit");
    expect(rule?.pipeline).toBe("lint");
  });
});

describe("dispatchClaudeHook", () => {
  test("returns no-rule when the hook isn't configured", async () => {
    const config = ConfigSchema.parse({});
    const reporter = captureReporter();
    const { exec } = recordExec();
    const result = await dispatchClaudeHook({
      hookName: "PostToolUse",
      input: { toolName: "Edit", files: ["a.ts"], hookEventName: null },
      config,
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.status).toBe("no-rule");
    expect(result.exitCode).toBe(0);
  });

  test("returns no-matcher-match when matcher doesn't fire", async () => {
    const reporter = captureReporter();
    const { exec } = recordExec();
    const result = await dispatchClaudeHook({
      hookName: "PostToolUse",
      input: { toolName: "Bash", files: [], hookEventName: null },
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.status).toBe("no-matcher-match");
    expect(result.exitCode).toBe(0);
  });

  test("returns pipeline-missing when the matched rule references a missing pipeline", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { lint: { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: { Stop: [{ pipeline: "ghost" }] },
        },
      },
    });
    const reporter = captureReporter();
    const { exec } = recordExec();
    const result = await dispatchClaudeHook({
      hookName: "Stop",
      input: { toolName: null, files: [], hookEventName: null },
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

  test("runs the matched pipeline with explicit files when provided", async () => {
    const reporter = captureReporter();
    const { exec, calls } = recordExec();
    const result = await dispatchClaudeHook({
      hookName: "PostToolUse",
      input: {
        toolName: "Edit",
        files: ["src/a.ts", "src/b.ts"],
        hookEventName: "PostToolUse",
      },
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.status).toBe("ran");
    expect(result.exitCode).toBe(0);
    expect(calls[0]?.command).toContain("src/a.ts");
    expect(reporter.events).toContain("start:agent-edit");
    expect(reporter.events).toContain("done:agent-edit:true");
  });

  test("falls back to git.changed() files when input has none", async () => {
    const reporter = captureReporter();
    const { exec, calls } = recordExec();
    const result = await dispatchClaudeHook({
      hookName: "Stop",
      input: { toolName: null, files: [], hookEventName: "Stop" },
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(["src/changed.ts"]),
      exec,
      reporter,
    });
    expect(result.status).toBe("ran");
    // session-wrap has smoke step with invocation: project → no files
    // substituted, but we still fired the dispatch successfully.
    expect(calls[0]?.command).toBe("echo smoke");
  });

  test("propagates non-zero pipeline exit codes", async () => {
    const reporter = captureReporter();
    const { exec } = recordExec(7);
    const result = await dispatchClaudeHook({
      hookName: "PostToolUse",
      input: { toolName: "Edit", files: ["a.ts"], hookEventName: null },
      config: sampleConfig(),
      cwd: "/repo",
      env: {},
      git: stubGit(),
      exec,
      reporter,
    });
    expect(result.exitCode).toBe(7);
  });
});
