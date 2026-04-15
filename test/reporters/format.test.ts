import { describe, expect, test } from "bun:test";
import {
  formatSummary,
  overallTag,
  pipelineDurationSeconds,
  stepDurationSeconds,
  statusGlyph,
  statusLabel,
} from "../../src/reporters/format.ts";
import type {
  PipelineResult,
  StepOutcome,
} from "../../src/runners/pipeline.ts";

function ranOutcome(
  overrides: Partial<StepOutcome> = {},
): StepOutcome {
  return {
    name: "step",
    kind: "ran",
    tags: [],
    result: {
      status: "passed",
      exitCode: 0,
      invocations: [],
      durationMs: 500,
    },
    ...overrides,
  };
}

describe("statusGlyph", () => {
  test("passed → ✓", () => {
    expect(statusGlyph(ranOutcome())).toBe("✓");
  });

  test("failed → ✗", () => {
    const outcome = ranOutcome({
      result: {
        status: "failed",
        exitCode: 1,
        invocations: [],
        durationMs: 100,
      },
    });
    expect(statusGlyph(outcome)).toBe("✗");
  });

  test("skipped run → ⊘", () => {
    const outcome = ranOutcome({
      result: {
        status: "skipped",
        exitCode: 0,
        invocations: [],
        durationMs: 10,
      },
    });
    expect(statusGlyph(outcome)).toBe("⊘");
  });

  test("excluded-by-tag → ⊘", () => {
    expect(
      statusGlyph({
        name: "x",
        kind: "excluded-by-tag",
        tags: [],
      }),
    ).toBe("⊘");
  });

  test("skipped-by-flag → ⊘", () => {
    expect(
      statusGlyph({
        name: "x",
        kind: "skipped-by-flag",
        tags: [],
      }),
    ).toBe("⊘");
  });

  test("skipped-by-gate → ⊘", () => {
    expect(
      statusGlyph({
        name: "x",
        kind: "skipped-by-gate",
        tags: [],
      }),
    ).toBe("⊘");
  });

  test("skipped-by-preflight → ⚠", () => {
    expect(
      statusGlyph({
        name: "x",
        kind: "skipped-by-preflight",
        tags: [],
      }),
    ).toBe("⚠");
  });

  test("missing result → ?", () => {
    expect(
      statusGlyph({
        name: "x",
        kind: "ran",
        tags: [],
      }),
    ).toBe("?");
  });
});

describe("statusLabel", () => {
  test("excluded-by-tag with reason", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "excluded-by-tag",
        tags: [],
        reason: "slow",
      }),
    ).toBe("excluded (slow)");
  });

  test("excluded-by-tag without reason falls back", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "excluded-by-tag",
        tags: [],
      }),
    ).toBe("excluded (tag filter)");
  });

  test("skipped-by-flag with reason", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-flag",
        tags: [],
        reason: "--skip",
      }),
    ).toBe("skipped (--skip)");
  });

  test("skipped-by-flag without reason falls back", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-flag",
        tags: [],
      }),
    ).toBe("skipped (flag)");
  });

  test("skipped-by-gate with reason", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-gate",
        tags: [],
        reason: "no changes under package.json since head",
      }),
    ).toBe("skipped by gate (no changes under package.json since head)");
  });

  test("skipped-by-gate without reason falls back", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-gate",
        tags: [],
      }),
    ).toBe("skipped by gate (no matching changes)");
  });

  test("skipped-by-preflight with reason lists missing deps", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-preflight",
        tags: [],
        reason: "command not on PATH: eslint",
      }),
    ).toBe("SKIPPED (missing: command not on PATH: eslint)");
  });

  test("skipped-by-preflight without reason falls back", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "skipped-by-preflight",
        tags: [],
      }),
    ).toBe("SKIPPED (missing: preflight)");
  });

  test("missing result → unknown", () => {
    expect(
      statusLabel({
        name: "x",
        kind: "ran",
        tags: [],
      }),
    ).toBe("unknown");
  });

  test("passed", () => {
    expect(statusLabel(ranOutcome())).toBe("passed");
  });

  test("failed with exit code", () => {
    expect(
      statusLabel(
        ranOutcome({
          result: {
            status: "failed",
            exitCode: 5,
            invocations: [],
            durationMs: 1,
          },
        }),
      ),
    ).toBe("failed (exit 5)");
  });

  test("skipped run with reason", () => {
    expect(
      statusLabel(
        ranOutcome({
          result: {
            status: "skipped",
            exitCode: 0,
            invocations: [],
            reason: "no matching files",
            durationMs: 1,
          },
        }),
      ),
    ).toBe("skipped (no matching files)");
  });

  test("skipped run without reason", () => {
    expect(
      statusLabel(
        ranOutcome({
          result: {
            status: "skipped",
            exitCode: 0,
            invocations: [],
            durationMs: 0,
          },
        }),
      ),
    ).toBe("skipped ()");
  });
});

describe("stepDurationSeconds / pipelineDurationSeconds / overallTag", () => {
  test("stepDurationSeconds returns seconds when a result exists", () => {
    expect(stepDurationSeconds(ranOutcome())).toBe("0.50");
  });

  test("stepDurationSeconds returns null for outcomes with no result", () => {
    expect(
      stepDurationSeconds({
        name: "x",
        kind: "excluded-by-tag",
        tags: [],
      }),
    ).toBeNull();
  });

  test("pipelineDurationSeconds formats milliseconds", () => {
    const result: PipelineResult = {
      pipelineName: "ci",
      ok: true,
      exitCode: 0,
      steps: [],
      durationMs: 2500,
    };
    expect(pipelineDurationSeconds(result)).toBe("2.50");
  });

  test("overallTag reports ok", () => {
    expect(
      overallTag({
        pipelineName: "ci",
        ok: true,
        exitCode: 0,
        steps: [],
        durationMs: 1,
      }),
    ).toBe("ok");
  });

  test("overallTag reports failed with exit code", () => {
    expect(
      overallTag({
        pipelineName: "ci",
        ok: false,
        exitCode: 3,
        steps: [],
        durationMs: 1,
      }),
    ).toBe("failed (exit 3)");
  });
});

describe("formatSummary", () => {
  test("renders header, per-step lines, and overall tag", () => {
    const out = formatSummary({
      pipelineName: "ci",
      ok: true,
      exitCode: 0,
      durationMs: 1234,
      steps: [
        ranOutcome({ name: "lint" }),
        {
          name: "e2e",
          kind: "excluded-by-tag",
          tags: ["slow"],
          reason: "slow",
        },
      ],
    });
    expect(out).toContain("pipeline: ci");
    expect(out).toContain("✓ lint");
    expect(out).toContain("(0.50s)");
    expect(out).toContain("⊘ e2e");
    expect(out).toContain("ok in 1.23s");
  });

  test("omits duration when outcome has no result", () => {
    const out = formatSummary({
      pipelineName: "ci",
      ok: true,
      exitCode: 0,
      durationMs: 100,
      steps: [
        {
          name: "lint",
          kind: "skipped-by-flag",
          tags: [],
          reason: "--skip",
        },
      ],
    });
    expect(out).toContain("⊘ lint");
    expect(out).not.toContain("(0.00s)");
  });
});
