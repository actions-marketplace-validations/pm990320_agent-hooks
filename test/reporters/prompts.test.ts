import { describe, expect, test } from "bun:test";
import { StepSchema, type Step } from "../../src/config/schema.ts";
import type { StepOutcome } from "../../src/runners/pipeline.ts";
import {
  applyPromptTemplate,
  defaultPromptForStep,
  detectPromptContext,
  detectPlaywrightCheckpoint,
  pickPromptPolicy,
  renderNextStepBlock,
  shouldEmitPrompt,
  yamlScalar,
} from "../../src/reporters/prompts.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function step(overrides: unknown): Step {
  return StepSchema.parse({ run: "echo", ...(overrides as Record<string, unknown>) });
}

function ranOutcome(opts: {
  name: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number;
  durationMs?: number;
  tags?: readonly string[];
  reason?: string;
}): StepOutcome {
  return {
    name: opts.name,
    kind: "ran",
    tags: opts.tags ?? [],
    result: {
      status: opts.status,
      exitCode: opts.exitCode ?? (opts.status === "failed" ? 1 : 0),
      invocations: [],
      durationMs: opts.durationMs ?? 1230,
      ...(opts.reason ? { reason: opts.reason } : {}),
    },
  };
}

async function withTempDir(
  testBody: (cwd: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-hooks-prompts-"));
  try {
    await testBody(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- Policy picker -------------------------------------------------------

describe("pickPromptPolicy", () => {
  test("agent context → always", () => {
    expect(pickPromptPolicy("agent", false)).toBe("always");
  });
  test("tty context → failures-only", () => {
    expect(pickPromptPolicy("tty", false)).toBe("failures-only");
  });
  test("ci context → failures-only", () => {
    expect(pickPromptPolicy("ci", false)).toBe("failures-only");
  });
  test("noPrompts wins regardless of context", () => {
    expect(pickPromptPolicy("agent", true)).toBe("never");
    expect(pickPromptPolicy("tty", true)).toBe("never");
  });
});

// --- shouldEmitPrompt ---------------------------------------------------

describe("shouldEmitPrompt", () => {
  test("never policy → always false", () => {
    const outcome = ranOutcome({ name: "lint", status: "failed" });
    expect(shouldEmitPrompt(outcome, "never")).toBe(false);
  });

  test("failures-only: passed steps don't emit", () => {
    const outcome = ranOutcome({ name: "lint", status: "passed" });
    expect(shouldEmitPrompt(outcome, "failures-only")).toBe(false);
  });

  test("failures-only: failed steps emit", () => {
    const outcome = ranOutcome({ name: "lint", status: "failed" });
    expect(shouldEmitPrompt(outcome, "failures-only")).toBe(true);
  });

  test("always: passed steps emit", () => {
    const outcome = ranOutcome({ name: "lint", status: "passed" });
    expect(shouldEmitPrompt(outcome, "always")).toBe(true);
  });

  test("always: failed steps emit", () => {
    const outcome = ranOutcome({ name: "lint", status: "failed" });
    expect(shouldEmitPrompt(outcome, "always")).toBe(true);
  });

  test("skipped outcomes never emit", () => {
    const outcome = ranOutcome({ name: "lint", status: "skipped" });
    expect(shouldEmitPrompt(outcome, "always")).toBe(false);
  });

  test("excluded-by-tag never emits", () => {
    const outcome: StepOutcome = {
      name: "e2e",
      kind: "excluded-by-tag",
      tags: ["slow"],
      reason: "exclude-tags",
    };
    expect(shouldEmitPrompt(outcome, "always")).toBe(false);
  });

  test("skipped-by-flag never emits", () => {
    const outcome: StepOutcome = {
      name: "lint",
      kind: "skipped-by-flag",
      tags: [],
      reason: "user --skip",
    };
    expect(shouldEmitPrompt(outcome, "always")).toBe(false);
  });

  test("outcome with no result never emits", () => {
    const outcome: StepOutcome = { name: "lint", kind: "ran", tags: [] };
    expect(shouldEmitPrompt(outcome, "always")).toBe(false);
  });
});

// --- Default prompt templates ------------------------------------------

describe("defaultPromptForStep", () => {
  test("e2e tag → e2e template", () => {
    const text = defaultPromptForStep(step({ tags: ["e2e"] }), "failed");
    expect(text).toContain("End-to-end");
  });

  test("test tag → test template", () => {
    const text = defaultPromptForStep(step({ tags: ["test"] }), "failed");
    expect(text).toContain("Unit tests");
  });

  test("typecheck tag → typecheck template", () => {
    const text = defaultPromptForStep(step({ tags: ["typecheck"] }), "failed");
    expect(text).toContain("Type check");
  });

  test("types tag also maps to typecheck template", () => {
    const text = defaultPromptForStep(step({ tags: ["types"] }), "failed");
    expect(text).toContain("Type check");
  });

  test("lint tag → lint template", () => {
    const text = defaultPromptForStep(step({ tags: ["lint"] }), "failed");
    expect(text).toContain("Lint");
  });

  test("format tag also maps to lint template", () => {
    const text = defaultPromptForStep(step({ tags: ["format"] }), "passed");
    expect(text).toContain("Lint");
  });

  test("build tag → build template", () => {
    const text = defaultPromptForStep(step({ tags: ["build"] }), "failed");
    expect(text).toContain("Build");
  });

  test("e2e + checkpoint detection uses checkpoint-aware defaults", () => {
    const text = defaultPromptForStep(
      step({ tags: ["e2e"] }),
      "failed",
      { playwrightCheckpoint: true },
    );
    expect(text).toContain("Playwright run failed");
    expect(text).toContain("test-results/checkpoints");
  });

  test("unknown tag → generic template", () => {
    const text = defaultPromptForStep(step({ tags: ["weird"] }), "failed");
    expect(text).toContain("Step failed");
  });

  test("priority order: e2e > test > typecheck > lint > build", () => {
    expect(
      defaultPromptForStep(step({ tags: ["e2e", "test", "lint"] }), "failed"),
    ).toContain("End-to-end");
    expect(
      defaultPromptForStep(step({ tags: ["test", "lint"] }), "failed"),
    ).toContain("Unit tests");
    expect(
      defaultPromptForStep(step({ tags: ["typecheck", "lint"] }), "failed"),
    ).toContain("Type check");
  });

  test("success variant for each template", () => {
    expect(defaultPromptForStep(step({ tags: ["lint"] }), "passed")).toContain(
      "passed",
    );
    expect(defaultPromptForStep(step({ tags: ["build"] }), "passed")).toContain(
      "succeeded",
    );
  });
});

// --- applyPromptTemplate -----------------------------------------------

describe("applyPromptTemplate", () => {
  test("substitutes known vars", () => {
    expect(
      applyPromptTemplate("step={step} status={status} dur={duration}", {
        step: "lint",
        status: "failed",
        duration: "1.2",
      }),
    ).toBe("step=lint status=failed dur=1.2");
  });

  test("leaves unknown tokens untouched", () => {
    expect(applyPromptTemplate("{step} {unknown}", { step: "x" })).toBe(
      "x {unknown}",
    );
  });
});

// --- yamlScalar ---------------------------------------------------------

describe("yamlScalar", () => {
  test("plain strings pass through", () => {
    expect(yamlScalar("ok")).toBe("ok");
  });

  test("empty string becomes double-quoted empty", () => {
    expect(yamlScalar("")).toBe('""');
  });

  test("strings with colons get quoted", () => {
    expect(yamlScalar("foo: bar")).toContain('"');
  });

  test("strings with newlines get escaped", () => {
    expect(yamlScalar("a\nb")).toBe('"a\\nb"');
  });

  test("leading whitespace gets quoted", () => {
    expect(yamlScalar(" leading")).toContain('"');
  });

  test("trailing whitespace gets quoted", () => {
    expect(yamlScalar("trailing ")).toContain('"');
  });

  test("backslashes get escaped", () => {
    expect(yamlScalar("a\\b: c")).toContain("\\\\");
  });
});

// --- renderNextStepBlock ------------------------------------------------

describe("renderNextStepBlock", () => {
  test("renders a complete fenced block for a passed step", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "lint",
        status: "passed",
        durationMs: 1230,
        tags: ["lint"],
      }),
      step: step({ tags: ["lint"] }),
      cwd: "/repo",
    });
    expect(block).toContain("---agent-hooks:next-step---");
    expect(block).toContain("step: lint");
    expect(block).toContain("status: passed");
    expect(block).toContain("exit_code: 0");
    expect(block).toContain("duration: 1.23s");
    expect(block).toContain("next: |");
    expect(block).toContain("Lint passed.");
    expect(block).toContain("---end---");
    expect(block.endsWith("\n")).toBe(true);
  });

  test("uses checkpoint-aware defaults when passed", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "e2e",
        status: "passed",
        tags: ["e2e"],
      }),
      step: step({ tags: ["e2e"] }),
      cwd: "/repo",
      playwrightCheckpoint: true,
    });
    expect(block).toContain("Playwright-Checkpoint artifacts");
    expect(block).toContain("Report:\n  ./report/index.html");
  });

  test("renders a failed step's next line from the failure template", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "test",
        status: "failed",
        exitCode: 2,
        tags: ["test"],
      }),
      step: step({ tags: ["test"] }),
      cwd: "/repo",
    });
    expect(block).toContain("status: failed");
    expect(block).toContain("exit_code: 2");
    expect(block).toContain("Unit tests failed.");
  });

  test("user step.prompts.on-failure overrides the default", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "lint",
        status: "failed",
        tags: ["lint"],
      }),
      step: step({
        tags: ["lint"],
        prompts: {
          "on-failure": "custom fail text for {step}",
        },
      }),
      cwd: "/repo",
    });
    expect(block).toContain("custom fail text for lint");
    expect(block).not.toContain("Lint failed.");
  });

  test("user step.prompts.on-success overrides the default", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "build",
        status: "passed",
        tags: ["build"],
      }),
      step: step({
        tags: ["build"],
        prompts: { "on-success": "all green! {step}={status}" },
      }),
      cwd: "/repo",
    });
    expect(block).toContain("all green! build=passed");
  });

  test("multi-line next block is indented under 'next: |'", () => {
    const block = renderNextStepBlock({
      outcome: ranOutcome({
        name: "lint",
        status: "failed",
        tags: ["lint"],
      }),
      step: step({
        tags: ["lint"],
        prompts: { "on-failure": "line one\nline two" },
      }),
      cwd: "/repo",
    });
    expect(block).toContain("next: |\n  line one\n  line two");
  });

  test("outcome without a result produces a minimal block", () => {
    const outcome: StepOutcome = { name: "mystery", kind: "ran", tags: [] };
    const block = renderNextStepBlock({
      outcome,
      step: step({}),
      cwd: "/repo",
    });
    expect(block).toContain("step: mystery");
    expect(block).toContain("status: unknown");
    // No `next: |` section because status is neither passed nor failed.
    expect(block).not.toContain("next: |");
  });
});

// --- detectPromptContext -----------------------------------------------

describe("detectPromptContext", () => {
  test("AGENT_HOOKS_CONTEXT=agent → agent", () => {
    expect(detectPromptContext({ AGENT_HOOKS_CONTEXT: "agent" })).toBe("agent");
  });
  test("AGENT_HOOKS_CONTEXT=ci → ci", () => {
    expect(detectPromptContext({ AGENT_HOOKS_CONTEXT: "ci" })).toBe("ci");
  });
  test("AGENT_HOOKS_CONTEXT=tty → tty", () => {
    expect(detectPromptContext({ AGENT_HOOKS_CONTEXT: "tty" })).toBe("tty");
  });
  test("GITHUB_ACTIONS=true → ci", () => {
    expect(detectPromptContext({ GITHUB_ACTIONS: "true" })).toBe("ci");
  });
  test("generic CI=true → ci", () => {
    expect(detectPromptContext({ CI: "true" })).toBe("ci");
  });
  test("CLAUDECODE=1 → agent", () => {
    expect(detectPromptContext({ CLAUDECODE: "1" })).toBe("agent");
  });
  test("CLAUDE_CODE=true → agent", () => {
    expect(detectPromptContext({ CLAUDE_CODE: "true" })).toBe("agent");
  });
  test("CURSOR_TRACE_ID set → agent", () => {
    expect(detectPromptContext({ CURSOR_TRACE_ID: "abc" })).toBe("agent");
  });
  test("AIDER set → agent", () => {
    expect(detectPromptContext({ AIDER: "1" })).toBe("agent");
  });
  test("bare env → tty", () => {
    expect(detectPromptContext({})).toBe("tty");
  });
});

// --- detectPlaywrightCheckpoint ---------------------------------------

describe("detectPlaywrightCheckpoint", () => {
  test("reads package.json dependencies", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ dependencies: { "playwright-checkpoint": "^1.0.0" }}),
        "utf8",
      );
      expect(await detectPlaywrightCheckpoint(cwd)).toBe(true);
    });
  });

  test("reads playwright.config globalTeardown", async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, "tests"), { recursive: true });
      await writeFile(
        join(cwd, "playwright.config.ts"),
        "export default { globalTeardown: 'playwright-checkpoint/teardown' };",
        "utf8",
      );
      expect(await detectPlaywrightCheckpoint(cwd)).toBe(true);
    });
  });

  test("scans e2e and test dirs for imports", async () => {
    await withTempDir(async (cwd) => {
      await mkdir(join(cwd, "e2e"), { recursive: true });
      await writeFile(
        join(cwd, "e2e", "smoke.test.ts"),
        "import checkpoint from \"playwright-checkpoint\";",
        "utf8",
      );
      expect(await detectPlaywrightCheckpoint(cwd)).toBe(true);
    });
  });

  test("returns false when no checkpoint signal exists", async () => {
    await withTempDir(async (cwd) => {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({}),
        "utf8",
      );
      expect(await detectPlaywrightCheckpoint(cwd)).toBe(false);
    });
  });
});
