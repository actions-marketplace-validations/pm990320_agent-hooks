import { describe, expect, test } from "bun:test";
import {
  ConfigSchema,
  PipelineSchema,
  StepSchema,
} from "../../src/config/schema.ts";

describe("StepSchema — run variants", () => {
  test("accepts string run", () => {
    const step = StepSchema.parse({ run: "eslint {files}" });
    expect(step.run).toBe("eslint {files}");
  });

  test("accepts object run with files variant only", () => {
    const step = StepSchema.parse({ run: { files: "eslint {files}" } });
    expect(typeof step.run).toBe("object");
  });

  test("accepts object run with project variant only", () => {
    const step = StepSchema.parse({ run: { project: "tsc --noEmit" } });
    expect(typeof step.run).toBe("object");
  });

  test("accepts object run with both variants", () => {
    const step = StepSchema.parse({
      run: {
        files: "vitest run --related {files}",
        project: "vitest run",
      },
    });
    expect(typeof step.run).toBe("object");
  });

  test("rejects empty object run", () => {
    expect(() => StepSchema.parse({ run: {} })).toThrow();
  });

  test("rejects empty string run", () => {
    expect(() => StepSchema.parse({ run: "" })).toThrow();
  });
});

describe("StepSchema — optional fields and defaults", () => {
  test("defaults invocation to args", () => {
    const step = StepSchema.parse({ run: "eslint" });
    expect(step.invocation).toBe("args");
  });

  test("defaults tags, requires, artifacts to empty arrays", () => {
    const step = StepSchema.parse({ run: "eslint" });
    expect(step.tags).toEqual([]);
    expect(step.requires).toEqual([]);
    expect(step.artifacts).toEqual([]);
  });

  test("accepts every invocation mode", () => {
    for (const mode of ["args", "per-file", "stdin", "xargs", "glob", "project"] as const) {
      const step = StepSchema.parse({ run: "x", invocation: mode });
      expect(step.invocation).toBe(mode);
    }
  });

  test("accepts chunk and parallel positive integers", () => {
    const step = StepSchema.parse({ run: "x", chunk: 200, parallel: 8 });
    expect(step.chunk).toBe(200);
    expect(step.parallel).toBe(8);
  });

  test("rejects chunk that isn't a positive integer", () => {
    expect(() => StepSchema.parse({ run: "x", chunk: 0 })).toThrow();
    expect(() => StepSchema.parse({ run: "x", chunk: -1 })).toThrow();
    expect(() => StepSchema.parse({ run: "x", chunk: 1.5 })).toThrow();
  });

  test("accepts every on-missing mode", () => {
    for (const mode of ["warn", "warn-skip", "skip", "fail"] as const) {
      const step = StepSchema.parse({ run: "x", "on-missing": mode });
      expect(step["on-missing"]).toBe(mode);
    }
  });

  test("accepts every requires shape", () => {
    const step = StepSchema.parse({
      run: "x",
      requires: [
        { command: "eslint" },
        { path: "node_modules/.bin" },
        { file: ".eslintrc.json" },
        { env: "NODE_ENV" },
        { "node-modules": true },
      ],
    });
    expect(step.requires).toHaveLength(5);
  });

  test("accepts area map with string when + string run", () => {
    const step = StepSchema.parse({
      run: "playwright test {files}",
      areas: {
        auth: { when: "src/auth/**", run: "e2e/auth/**/*.spec.ts" },
      },
    });
    expect(step.areas?.["auth"]?.when).toBe("src/auth/**");
  });

  test("accepts area map with array when + array run", () => {
    const step = StepSchema.parse({
      run: "playwright test {files}",
      areas: {
        checkout: {
          when: ["src/checkout/**", "src/payment/**"],
          run: ["e2e/checkout/**", "e2e/payment/**"],
        },
      },
    });
    expect(Array.isArray(step.areas?.["checkout"]?.when)).toBe(true);
  });

  test("accepts every unmatched value", () => {
    for (const value of ["skip", "all", "smoke"] as const) {
      const step = StepSchema.parse({ run: "x", unmatched: value });
      expect(step.unmatched).toBe(value);
    }
  });

  test("accepts prompts block", () => {
    const step = StepSchema.parse({
      run: "x",
      prompts: {
        "on-success": "all good",
        "on-failure": "fix it",
      },
    });
    expect(step.prompts?.["on-failure"]).toBe("fix it");
  });

  test("accepts a when-changed block with string paths", () => {
    const step = StepSchema.parse({
      run: "x",
      "when-changed": { paths: "package.json", since: "head" },
    });
    expect(step["when-changed"]?.paths).toBe("package.json");
    expect(step["when-changed"]?.since).toBe("head");
  });

  test("accepts a when-changed block with array paths", () => {
    const step = StepSchema.parse({
      run: "x",
      "when-changed": {
        paths: ["package.json", "bun.lockb"],
        since: "merge-base",
      },
    });
    expect(Array.isArray(step["when-changed"]?.paths)).toBe(true);
  });

  test("when-changed.since defaults to head when omitted", () => {
    const step = StepSchema.parse({
      run: "x",
      "when-changed": { paths: "package.json" },
    });
    expect(step["when-changed"]?.since).toBe("head");
  });

  test("accepts when-changed.since: last-run", () => {
    const step = StepSchema.parse({
      run: "x",
      "when-changed": { paths: "x", since: "last-run" },
    });
    expect(step["when-changed"]?.since).toBe("last-run");
  });

  test("rejects unknown when-changed.since values", () => {
    expect(() =>
      StepSchema.parse({
        run: "x",
        "when-changed": { paths: "x", since: "yesterday" },
      }),
    ).toThrow();
  });

  test("rejects unknown step fields (strict)", () => {
    expect(() => StepSchema.parse({ run: "x", nope: 1 })).toThrow();
  });
});

describe("PipelineSchema", () => {
  test("requires at least one step", () => {
    expect(() => PipelineSchema.parse({ steps: [] })).toThrow();
  });

  test("defaults parallel to false and continue-on-error to false", () => {
    const pipe = PipelineSchema.parse({ steps: ["lint"] });
    expect(pipe.parallel).toBe(false);
    expect(pipe["continue-on-error"]).toBe(false);
  });

  test("defaults tag lists to empty", () => {
    const pipe = PipelineSchema.parse({ steps: ["lint"] });
    expect(pipe["exclude-tags"]).toEqual([]);
    expect(pipe["include-tags"]).toEqual([]);
  });

  test("accepts on-excluded values", () => {
    for (const value of ["silent", "warn"] as const) {
      const pipe = PipelineSchema.parse({
        steps: ["lint"],
        "on-excluded": value,
      });
      expect(pipe["on-excluded"]).toBe(value);
    }
  });

  test("rejects unknown pipeline fields (strict)", () => {
    expect(() => PipelineSchema.parse({ steps: ["lint"], nope: 1 })).toThrow();
  });
});

describe("ConfigSchema — root", () => {
  test("accepts an empty config and fills in defaults", () => {
    const config = ConfigSchema.parse({});
    expect(config.steps).toEqual({});
    expect(config.pipelines).toEqual({});
  });

  test("accepts a minimal realistic config", () => {
    const config = ConfigSchema.parse({
      name: "my-app",
      steps: {
        lint: { run: "eslint {files}" },
        typecheck: { run: "tsc --noEmit", invocation: "project" },
      },
      pipelines: {
        ci: { steps: ["lint", "typecheck"] },
      },
    });
    expect(config.name).toBe("my-app");
    expect(Object.keys(config.steps)).toEqual(["lint", "typecheck"]);
  });

  test("accepts the full beads block with defaults", () => {
    const config = ConfigSchema.parse({ beads: {} });
    expect(config.beads?.enabled).toBe("auto");
    expect(config.beads?.["pre-commit"]).toBe("stage");
    expect(config.beads?.["commit-message"]).toBe("chore(beads): sync");
  });

  test("accepts agents with hook rules", () => {
    const config = ConfigSchema.parse({
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
    expect(config.agents?.["claude-code"]?.hooks?.PostToolUse).toHaveLength(1);
  });

  test("accepts the install block with default", () => {
    const config = ConfigSchema.parse({ install: {} });
    expect(config.install?.postinstall).toBe("auto");
  });

  test("accepts every install.postinstall value", () => {
    for (const value of ["auto", "managed", "off"] as const) {
      const config = ConfigSchema.parse({ install: { postinstall: value } });
      expect(config.install?.postinstall).toBe(value);
    }
  });

  test("accepts the doctor suppress list", () => {
    const config = ConfigSchema.parse({
      doctor: { suppress: ["playwright-checkpoint"] },
    });
    expect(config.doctor?.suppress).toEqual(["playwright-checkpoint"]);
  });

  test("accepts the git section with hook rules", () => {
    const config = ConfigSchema.parse({
      git: {
        enabled: true,
        hooks: {
          "pre-commit": { pipeline: "pre-commit" },
          "pre-push": { pipeline: "pre-push" },
          "post-merge": { pipeline: "reinstall" },
        },
      },
    });
    expect(config.git?.enabled).toBe(true);
    expect(config.git?.hooks?.["pre-commit"]?.pipeline).toBe("pre-commit");
  });

  test("git.enabled defaults to auto when the git section is present but empty", () => {
    const config = ConfigSchema.parse({ git: {} });
    expect(config.git?.enabled).toBe("auto");
  });

  test("rejects unknown git hook names", () => {
    expect(() =>
      ConfigSchema.parse({
        git: { hooks: { "not-a-real-hook": { pipeline: "x" } } },
      }),
    ).toThrow();
  });

  test("accepts env maps at root and per-step", () => {
    const config = ConfigSchema.parse({
      env: { NODE_ENV: "development" },
      steps: { lint: { run: "x", env: { CUSTOM: "value" } } },
    });
    expect(config.env?.NODE_ENV).toBe("development");
    expect(config.steps.lint?.env?.CUSTOM).toBe("value");
  });

  test("rejects unknown root fields (strict)", () => {
    expect(() => ConfigSchema.parse({ nope: 1 })).toThrow();
  });

  test("accepts $schema pointer", () => {
    const config = ConfigSchema.parse({
      $schema: "./node_modules/agent-hooks/schema.json",
    });
    expect(config.$schema).toBe("./node_modules/agent-hooks/schema.json");
  });
});
