import { describe, expect, test } from "bun:test";
import {
  createConsoleReporter,
  createGitHubActionsReporter,
  pickReporter,
} from "../../src/reporters/index.ts";
import { consoleStepEndIsNoop } from "../../src/reporters/console.ts";
import type {
  PipelineResult,
  StepOutcome,
} from "../../src/runners/pipeline.ts";

function captureWriter(): {
  write: (text: string) => void;
  out: () => string;
} {
  let buf = "";
  return {
    write: (text) => {
      buf += text;
    },
    out: () => buf,
  };
}

function passedResult(): PipelineResult {
  return {
    pipelineName: "ci",
    ok: true,
    exitCode: 0,
    durationMs: 100,
    steps: [
      {
        name: "lint",
        kind: "ran",
        tags: [],
        result: {
          status: "passed",
          exitCode: 0,
          invocations: [],
          durationMs: 10,
        },
      },
    ],
  };
}

function failedResult(): PipelineResult {
  return {
    pipelineName: "ci",
    ok: false,
    exitCode: 2,
    durationMs: 100,
    steps: [
      {
        name: "typecheck",
        kind: "ran",
        tags: [],
        result: {
          status: "failed",
          exitCode: 2,
          invocations: [],
          durationMs: 10,
        },
      },
    ],
  };
}

describe("createConsoleReporter", () => {
  test("prints the summary at pipelineEnd", () => {
    const { write, out } = captureWriter();
    const reporter = createConsoleReporter(write);
    reporter.pipelineStart("ci");
    reporter.stepStart({ name: "lint", tags: [] });
    reporter.stepEnd({
      name: "lint",
      kind: "ran",
      tags: [],
      result: {
        status: "passed",
        exitCode: 0,
        invocations: [],
        durationMs: 1,
      },
    });
    reporter.pipelineEnd(passedResult());
    expect(out()).toContain("pipeline: ci");
    expect(out()).toContain("✓ lint");
    expect(out()).toContain("ok in 0.10s");
  });

  test("stepStart and stepEnd are no-ops", () => {
    const { write, out } = captureWriter();
    const reporter = createConsoleReporter(write);
    reporter.stepStart({ name: "lint", tags: [] });
    reporter.stepEnd({
      name: "lint",
      kind: "ran",
      tags: [],
      result: {
        status: "passed",
        exitCode: 0,
        invocations: [],
        durationMs: 1,
      },
    });
    expect(out()).toBe("");
  });

  test("consoleStepEndIsNoop is callable as the step-end handler", () => {
    const outcome: StepOutcome = {
      name: "lint",
      kind: "ran",
      tags: [],
    };
    expect(() => consoleStepEndIsNoop(outcome)).not.toThrow();
  });
});

describe("createGitHubActionsReporter", () => {
  test("wraps steps in ::group::/::endgroup:: markers", () => {
    const { write, out } = captureWriter();
    const reporter = createGitHubActionsReporter(write);
    reporter.pipelineStart("ci");
    reporter.stepStart({ name: "lint", tags: [] });
    reporter.stepEnd({
      name: "lint",
      kind: "ran",
      tags: [],
      result: {
        status: "passed",
        exitCode: 0,
        invocations: [],
        durationMs: 1,
      },
    });
    reporter.pipelineEnd(passedResult());
    const output = out();
    expect(output).toContain("::group::agent-hooks pipeline: ci");
    expect(output).toContain("::group::lint");
    expect(output).toContain("::endgroup::");
    // Summary still printed for humans scrolling the raw log.
    expect(output).toContain("pipeline: ci");
  });

  test("emits ::error:: annotation for failed steps", () => {
    const { write, out } = captureWriter();
    const reporter = createGitHubActionsReporter(write);
    reporter.pipelineStart("ci");
    reporter.stepStart({ name: "typecheck", tags: [] });
    reporter.stepEnd({
      name: "typecheck",
      kind: "ran",
      tags: [],
      result: {
        status: "failed",
        exitCode: 2,
        invocations: [],
        durationMs: 1,
      },
    });
    reporter.pipelineEnd(failedResult());
    const output = out();
    expect(output).toContain("::error title=typecheck::typecheck failed (exit 2)");
    expect(output).toContain("::error title=ci::pipeline failed with exit 2");
  });

  test("does not emit step-level ::error:: for skipped or excluded steps", () => {
    const { write, out } = captureWriter();
    const reporter = createGitHubActionsReporter(write);
    reporter.stepEnd({
      name: "lint",
      kind: "excluded-by-tag",
      tags: ["slow"],
      reason: "slow",
    });
    reporter.stepEnd({
      name: "lint",
      kind: "ran",
      tags: [],
      // no result — outcome with missing status isn't "failed"
    });
    expect(out()).not.toContain("::error");
  });
});

describe("pickReporter", () => {
  test("returns console reporter when GITHUB_ACTIONS is unset", () => {
    const { write } = captureWriter();
    const reporter = pickReporter({ env: {}, write });
    expect(typeof reporter.pipelineStart).toBe("function");
    // Sanity: console reporter's stepStart is silent.
    const { write: w2, out } = captureWriter();
    const r2 = pickReporter({ env: {}, write: w2 });
    r2.stepStart({ name: "x", tags: [] });
    expect(out()).toBe("");
  });

  test("returns GH Actions reporter when GITHUB_ACTIONS=true", () => {
    const { write, out } = captureWriter();
    const reporter = pickReporter({
      env: { GITHUB_ACTIONS: "true" },
      write,
    });
    reporter.stepStart({ name: "x", tags: [] });
    expect(out()).toContain("::group::x");
  });

  test("forceKind: console overrides env", () => {
    const { write, out } = captureWriter();
    const reporter = pickReporter({
      env: { GITHUB_ACTIONS: "true" },
      write,
      forceKind: "console",
    });
    reporter.stepStart({ name: "x", tags: [] });
    expect(out()).toBe("");
  });

  test("forceKind: github-actions overrides env", () => {
    const { write, out } = captureWriter();
    const reporter = pickReporter({
      env: {},
      write,
      forceKind: "github-actions",
    });
    reporter.stepStart({ name: "x", tags: [] });
    expect(out()).toContain("::group::x");
  });
});
