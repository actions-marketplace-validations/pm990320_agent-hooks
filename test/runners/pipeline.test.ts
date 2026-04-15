import { describe, expect, test } from "bun:test";
import { ConfigSchema, type Config } from "../../src/config/schema.ts";
import {
  PipelineError,
  applyFilters,
  runPipeline,
  type PipelineOptions,
} from "../../src/runners/pipeline.ts";
import type { ExecFn, ExecInput } from "../../src/runners/step.ts";

// --- Shared helpers ------------------------------------------------------

function recordExec(
  exitCodeFor: (input: ExecInput) => number = () => 0,
): {
  calls: ExecInput[];
  exec: ExecFn;
} {
  const calls: ExecInput[] = [];
  const exec: ExecFn = (input) => {
    calls.push(input);
    return Promise.resolve({ exitCode: exitCodeFor(input), durationMs: 1 });
  };
  return { calls, exec };
}

function baseConfig(): Config {
  return ConfigSchema.parse({
    steps: {
      lint: {
        run: "eslint {files}",
        files: "**/*.ts",
        tags: ["fast", "lint"],
      },
      typecheck: {
        run: "tsc --noEmit",
        invocation: "project",
        tags: ["fast"],
      },
      test: {
        run: "vitest run --related {files}",
        files: "**/*.ts",
        tags: ["fast", "unit"],
      },
      e2e: {
        run: "playwright test",
        invocation: "project",
        tags: ["slow", "e2e", "browser"],
      },
      build: {
        run: "vite build",
        invocation: "project",
        tags: ["slow"],
      },
    },
    pipelines: {
      ci: {
        steps: ["lint", "typecheck", "test", "e2e", "build"],
      },
      "pre-commit": {
        steps: ["lint", "typecheck", "test", "e2e", "build"],
        parallel: true,
        "exclude-tags": ["slow"],
      },
      "agent-edit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
        "exclude-tags": ["slow", "browser", "e2e"],
      },
      "fast-only": {
        steps: ["lint", "typecheck", "test", "e2e", "build"],
        "include-tags": ["fast"],
      },
      resilient: {
        steps: ["lint", "test"],
        "continue-on-error": true,
      },
    },
  });
}

function baseOptions(
  overrides: Partial<PipelineOptions> = {},
): PipelineOptions {
  return {
    pipelineName: "ci",
    config: baseConfig(),
    files: ["src/a.ts", "src/b.ts"],
    cwd: "/repo",
    ...overrides,
  };
}

// --- applyFilters --------------------------------------------------------

describe("applyFilters", () => {
  test("keeps everything when no tags and no flags", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["ci"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {});
    expect(result.kept).toHaveLength(5);
    expect(result.outcomes).toHaveLength(0);
  });

  test("drops steps matching exclude-tags", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["agent-edit"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {});
    expect(result.kept.map((e) => e.name)).toEqual(["lint", "typecheck", "test"]);
  });

  test("include-tags keeps only matching steps", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["fast-only"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {});
    const keptNames = result.kept.map((e) => e.name);
    expect(keptNames).toEqual(["lint", "typecheck", "test"]);
    const excludedNames = result.outcomes.map((o) => o.name);
    expect(excludedNames).toEqual(["e2e", "build"]);
  });

  test("--only keeps only requested steps", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["ci"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {
      only: new Set(["lint"]),
    });
    expect(result.kept.map((e) => e.name)).toEqual(["lint"]);
    expect(result.outcomes).toHaveLength(4);
    expect(result.outcomes.every((o) => o.kind === "skipped-by-flag")).toBe(true);
  });

  test("--skip drops requested steps", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["ci"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {
      skip: new Set(["e2e", "build"]),
    });
    expect(result.kept.map((e) => e.name)).toEqual([
      "lint",
      "typecheck",
      "test",
    ]);
    expect(result.outcomes).toHaveLength(2);
  });

  test("records reasons for excluded steps", () => {
    const config = baseConfig();
    const pipeline = config.pipelines["agent-edit"]!;
    const entries = pipeline.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const result = applyFilters(entries, pipeline, {});
    const outcome = result.outcomes[0];
    // agent-edit only references lint/typecheck/test, and none of those
    // carry the excluded tags, so no exclude-tag outcomes here. Assert
    // the structure for an actual exclusion via a different pipeline.
    expect(outcome).toBeUndefined();
    const wide = config.pipelines["pre-commit"]!;
    const wideEntries = wide.steps.map((name) => ({
      name,
      step: config.steps[name]!,
    }));
    const wideResult = applyFilters(wideEntries, wide, {});
    const excluded = wideResult.outcomes.find((o) => o.name === "e2e");
    expect(excluded?.kind).toBe("excluded-by-tag");
    expect(excluded?.reason).toContain("slow");
  });
});

// --- runPipeline errors --------------------------------------------------

describe("runPipeline — errors", () => {
  test("throws PipelineError when the pipeline is not defined", async () => {
    const { exec } = recordExec();
    await expect(
      runPipeline(
        baseOptions({ pipelineName: "missing-pipe" }),
        exec,
      ),
    ).rejects.toBeInstanceOf(PipelineError);
  });

  test("throws PipelineError when a step reference is missing", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "eslint" } },
      pipelines: { ci: { steps: ["lint", "ghost"] } },
    });
    const { exec } = recordExec();
    await expect(
      runPipeline(baseOptions({ config }), exec),
    ).rejects.toBeInstanceOf(PipelineError);
  });
});

// --- runPipeline execution ----------------------------------------------

describe("runPipeline — execution", () => {
  test("runs every step in sequence and returns ok when all pass", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(baseOptions(), exec);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.steps).toHaveLength(5);
    expect(result.steps.every((o) => o.kind === "ran")).toBe(true);
    // Every step ran at least once.
    const commandNames = calls.map((c) => c.command.split(" ")[0]);
    expect(commandNames).toContain("eslint");
    expect(commandNames).toContain("tsc");
    expect(commandNames).toContain("vitest");
    expect(commandNames).toContain("playwright");
    expect(commandNames).toContain("vite");
  });

  test("stops on first failure in sequential mode", async () => {
    const { calls, exec } = recordExec((input) =>
      input.command.startsWith("tsc") ? 2 : 0,
    );
    const result = await runPipeline(baseOptions(), exec);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    // lint + typecheck should have run; test/e2e/build should not.
    const commandNames = calls.map((c) => c.command.split(" ")[0]);
    expect(commandNames).toContain("eslint");
    expect(commandNames).toContain("tsc");
    expect(commandNames).not.toContain("vitest");
    expect(commandNames).not.toContain("playwright");
    expect(commandNames).not.toContain("vite");
  });

  test("continue-on-error runs remaining steps even after a failure", async () => {
    const { calls, exec } = recordExec((input) =>
      input.command.startsWith("eslint") ? 1 : 0,
    );
    const result = await runPipeline(
      baseOptions({ pipelineName: "resilient" }),
      exec,
    );
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const commandNames = calls.map((c) => c.command.split(" ")[0]);
    expect(commandNames).toContain("eslint");
    expect(commandNames).toContain("vitest");
  });

  test("parallel mode runs steps concurrently and preserves step order in results", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      baseOptions({ pipelineName: "agent-edit", files: ["src/a.ts"] }),
      exec,
    );
    expect(result.ok).toBe(true);
    expect(result.steps.map((o) => o.name)).toEqual([
      "lint",
      "typecheck",
      "test",
    ]);
  });

  test("exclude-tags removes slow steps from pre-commit pipeline", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(
      baseOptions({ pipelineName: "pre-commit" }),
      exec,
    );
    expect(result.ok).toBe(true);
    const ran = result.steps.filter((o) => o.kind === "ran").map((o) => o.name);
    const excluded = result.steps
      .filter((o) => o.kind === "excluded-by-tag")
      .map((o) => o.name);
    expect(ran).toEqual(["lint", "typecheck", "test"]);
    expect(excluded).toEqual(["e2e", "build"]);
    // e2e / build should never have been executed.
    const commandNames = calls.map((c) => c.command.split(" ")[0]);
    expect(commandNames).not.toContain("playwright");
    expect(commandNames).not.toContain("vite");
  });

  test("applies the per-step files glob to the incoming file list", async () => {
    const { calls, exec } = recordExec();
    await runPipeline(
      baseOptions({
        pipelineName: "agent-edit",
        files: ["src/a.ts", "docs/readme.md"],
      }),
      exec,
    );
    // lint's files glob is **/*.ts, so docs/readme.md should not appear
    // in the eslint invocation.
    const eslintCall = calls.find((c) => c.command.startsWith("eslint"));
    expect(eslintCall?.command).toContain("src/a.ts");
    expect(eslintCall?.command).not.toContain("readme.md");
  });

  test("--only runs only the requested steps", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(
      baseOptions({ only: new Set(["lint"]) }),
      exec,
    );
    const ran = result.steps.filter((o) => o.kind === "ran").map((o) => o.name);
    expect(ran).toEqual(["lint"]);
    expect(calls).toHaveLength(1);
  });

  test("--skip drops the named steps", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(
      baseOptions({ skip: new Set(["e2e", "build"]) }),
      exec,
    );
    const ran = result.steps.filter((o) => o.kind === "ran").map((o) => o.name);
    expect(ran).toEqual(["lint", "typecheck", "test"]);
    expect(calls.map((c) => c.command.split(" ")[0])).not.toContain("playwright");
  });

  test("respects a --jobs cap for parallel pipelines", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      baseOptions({ pipelineName: "agent-edit", jobs: 1 }),
      exec,
    );
    expect(result.ok).toBe(true);
  });
});

describe("runPipeline — change gates", () => {
  function gatedConfig() {
    return ConfigSchema.parse({
      steps: {
        lint: {
          run: "echo lint {files}",
          files: "**/*.ts",
          tags: ["fast"],
        },
        "license-audit": {
          run: "echo audit",
          invocation: "project",
          "when-changed": {
            paths: "package.json",
            since: "head",
          },
        },
      },
      pipelines: {
        ci: { steps: ["lint", "license-audit"] },
      },
    });
  }

  function gitStub(
    staged: readonly string[],
    changed: readonly string[],
  ) {
    return {
      staged: () => Promise.resolve(staged),
      changed: () => Promise.resolve(changed),
      all: () => Promise.resolve([]),
    };
  }

  test("skips the gated step when no watched paths changed", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: ["src/a.ts"],
        cwd: "/repo",
        git: gitStub(["src/a.ts"], []),
      },
      exec,
    );
    const gated = result.steps.find((o) => o.name === "license-audit");
    expect(gated?.kind).toBe("skipped-by-gate");
    // audit command should never have run.
    expect(calls.some((c) => c.command.includes("audit"))).toBe(false);
  });

  test("runs the gated step when a watched path is in the diff", async () => {
    const { calls, exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: [],
        cwd: "/repo",
        git: gitStub(["package.json"], []),
      },
      exec,
    );
    const gated = result.steps.find((o) => o.name === "license-audit");
    expect(gated?.kind).toBe("ran");
    expect(calls.some((c) => c.command.includes("audit"))).toBe(true);
  });

  test("forceGates bypasses the gate and runs the step regardless", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: [],
        cwd: "/repo",
        git: gitStub([], []),
        forceGates: true,
      },
      exec,
    );
    const gated = result.steps.find((o) => o.name === "license-audit");
    expect(gated?.kind).toBe("ran");
  });

  test("omitting the git runner leaves gates unevaluated (steps run)", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: [],
        cwd: "/repo",
      },
      exec,
    );
    const gated = result.steps.find((o) => o.name === "license-audit");
    expect(gated?.kind).toBe("ran");
  });
});

describe("runPipeline — preflight", () => {
  function gatedConfig() {
    return ConfigSchema.parse({
      steps: {
        lint: {
          run: "echo lint {files}",
          requires: [{ command: "definitely-not-a-real-binary" }],
        },
      },
      pipelines: {
        ci: { steps: ["lint"] },
      },
    });
  }

  function memResolver(opts: { commands?: Set<string> }) {
    return {
      whichCommand: (name: string) =>
        Promise.resolve(opts.commands?.has(name) ? `/usr/bin/${name}` : null),
      getEnv: () => null,
      fs: { exists: () => Promise.resolve(false) },
    };
  }

  test("fails the step when manual context + missing requires", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: ["src/a.ts"],
        cwd: "/repo",
        preflightContext: "manual",
        preflightResolver: memResolver({}),
      },
      exec,
    );
    expect(result.ok).toBe(false);
    const lintOutcome = result.steps.find((s) => s.name === "lint");
    expect(lintOutcome?.kind).toBe("ran");
    expect(lintOutcome?.result?.status).toBe("failed");
    expect(lintOutcome?.result?.exitCode).toBe(3);
  });

  test("warn-skips the step in git-hook context", async () => {
    const { exec, calls } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: ["src/a.ts"],
        cwd: "/repo",
        preflightContext: "git-hook",
        preflightResolver: memResolver({}),
      },
      exec,
    );
    expect(result.ok).toBe(true);
    const lintOutcome = result.steps.find((s) => s.name === "lint");
    expect(lintOutcome?.kind).toBe("skipped-by-preflight");
    expect(calls).toHaveLength(0); // never executed
  });

  test("runs normally when requires are satisfied", async () => {
    const { exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config: gatedConfig(),
        files: ["src/a.ts"],
        cwd: "/repo",
        preflightContext: "manual",
        preflightResolver: memResolver({
          commands: new Set(["definitely-not-a-real-binary"]),
        }),
      },
      exec,
    );
    expect(result.ok).toBe(true);
  });

  test("warn policy lets the step run anyway", async () => {
    const config = ConfigSchema.parse({
      steps: {
        lint: {
          run: "echo lint",
          // project mode so the step doesn't auto-skip with an empty
          // file list — we want to exercise the warn → fall-through.
          invocation: "project",
          requires: [{ command: "missing" }],
          "on-missing": "warn",
        },
      },
      pipelines: { ci: { steps: ["lint"] } },
    });
    const { exec, calls } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config,
        files: [],
        cwd: "/repo",
        preflightContext: "manual",
        preflightResolver: memResolver({}),
      },
      exec,
    );
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("explicit on-missing: skip suppresses both warn and run", async () => {
    const config = ConfigSchema.parse({
      steps: {
        lint: {
          run: "echo lint",
          requires: [{ command: "missing" }],
          "on-missing": "skip",
        },
      },
      pipelines: { ci: { steps: ["lint"] } },
    });
    const { exec } = recordExec();
    const result = await runPipeline(
      {
        pipelineName: "ci",
        config,
        files: [],
        cwd: "/repo",
        preflightContext: "manual",
        preflightResolver: memResolver({}),
      },
      exec,
    );
    expect(result.steps[0]?.kind).toBe("skipped-by-preflight");
  });
});

describe("PipelineError", () => {
  test("carries a code for branching", () => {
    const err = new PipelineError("x", "not-found");
    expect(err.name).toBe("PipelineError");
    expect(err.code).toBe("not-found");
  });
});
