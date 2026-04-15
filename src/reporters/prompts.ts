/**
 * Agent feedback prompts (PLAN §6a) — after each step runs, emit a
 * fenced YAML-ish block to stderr telling the calling agent what to
 * do next. The block is deliberately machine-readable but also
 * human-skimmable, so a developer watching a terminal can parse it too.
 *
 * Block shape:
 *
 *     ---agent-hooks:next-step---
 *     step: lint
 *     status: failed
 *     exit_code: 1
 *     duration: 1.23s
 *     summary: 2 errors, 0 warnings
 *     next: |
 *       <what the agent should do>
 *     ---end---
 *
 * Emission is context-aware:
 *
 *   - agent context → every step emits (the caller needs the feedback)
 *   - tty context   → only failures emit (humans don't need pings on green)
 *   - ci context    → only failures emit; future work writes a report file
 *
 * Users can override per-step via `step.prompts.on-success / on-failure`.
 * Defaults are synthesized based on step tags (lint/typecheck/test/build/e2e).
 */

import type { Step } from "../config/schema.ts";
import type { StepOutcome } from "../runners/pipeline.ts";
import { joinFiles } from "../runners/step.ts";
import { stepDurationSeconds } from "./format.ts";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const PC_IMPORT_RE = /\bfrom\s+["']playwright-checkpoint\/?/;
const PC_GLOBAL_TEARDOWN_RE =
  /globalTeardown\s*:\s*["']playwright-checkpoint\/teardown["']/;
const PC_DEPENDENCY_KEYS = ["dependencies", "devDependencies", "peerDependencies"];

export type PromptContext = "agent" | "tty" | "ci";

export type PromptPolicy = "always" | "failures-only" | "never";

/**
 * Pick the emission policy for a given context. `--no-prompts` short
 * circuits to `never` regardless of what the context would normally do.
 */
export function pickPromptPolicy(
  context: PromptContext,
  noPrompts: boolean,
): PromptPolicy {
  if (noPrompts) return "never";
  if (context === "agent") return "always";
  return "failures-only";
}

/**
 * Decide whether this outcome should produce a prompt under the given
 * policy. Excluded/skipped outcomes never emit regardless — the runner
 * already printed a skip line, and prompts are about actionable
 * feedback, not "we didn't run this".
 */
export function shouldEmitPrompt(
  outcome: StepOutcome,
  policy: PromptPolicy,
): boolean {
  if (policy === "never") return false;
  if (outcome.kind !== "ran") return false;
  const status = outcome.result?.status;
  if (!status || status === "skipped") return false;
  if (policy === "failures-only") return status === "failed";
  return true;
}

// --- Block rendering ----------------------------------------------------

export interface NextStepBlockInput {
  readonly outcome: StepOutcome;
  /** The step config (for `prompts:` overrides and tags). */
  readonly step: Step;
  /** Base cwd for the `{cwd}` template var. */
  readonly cwd: string;
  /** When true, `e2e` defaults become checkpoint-aware. */
  readonly playwrightCheckpoint?: boolean;
  /** Effective files used by the step after area resolution. */
  readonly files?: readonly string[];
  /** Artifact paths surfaced for this step. */
  readonly artifacts?: readonly string[];
}

/**
 * Render the full fenced block for a step outcome. Always ends with a
 * trailing newline so callers can concatenate without worrying about
 * joining separators.
 */
export function renderNextStepBlock(input: NextStepBlockInput): string {
  const { outcome, step, cwd } = input;
  const status = outcome.result?.status ?? "unknown";
  const exitCode = outcome.result?.exitCode ?? 0;
  const duration = stepDurationSeconds(outcome) ?? "0.00";
  const summary = summaryFor(outcome);
  const files = input.files ?? outcome.result?.files ?? [];
  const artifacts = input.artifacts ?? [];
  const next = resolveNextText({
    outcome,
    step,
    cwd,
    summary,
    duration,
    exitCode,
    files,
    artifacts,
    playwrightCheckpoint: input.playwrightCheckpoint ?? false,
  });

  const lines: string[] = [];
  lines.push("---agent-hooks:next-step---");
  lines.push(`step: ${outcome.name}`);
  lines.push(`status: ${status}`);
  lines.push(`exit_code: ${String(exitCode)}`);
  lines.push(`duration: ${duration}s`);
  lines.push(`summary: ${yamlScalar(summary)}`);
  lines.push("artifacts:");
  if (artifacts.length === 0) {
    lines.push("  - <none>");
  } else {
    for (const artifact of artifacts) {
      lines.push(`  - ${yamlScalar(artifact)}`);
    }
  }
  if (next.length > 0) {
    lines.push("next: |");
    for (const line of next.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  lines.push("---end---");
  lines.push("");
  return lines.join("\n");
}

function summaryFor(outcome: StepOutcome): string {
  const status = outcome.result?.status;
  if (status === "passed") return "ok";
  if (status === "failed") {
    return `exited ${String(outcome.result?.exitCode ?? 1)}`;
  }
  return outcome.reason ?? "unknown";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function hasPlaywrightCheckpointDependency(cwd: string): Promise<boolean> {
  const pkg = await readText(join(cwd, "package.json"));
  if (!pkg) return false;
  try {
    const parsed = JSON.parse(pkg) as Record<string, unknown>;
    for (const key of PC_DEPENDENCY_KEYS) {
      const deps = parsed[key];
      if (
        typeof deps === "object" &&
        deps !== null &&
        Object.prototype.hasOwnProperty.call(deps, "playwright-checkpoint")
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function hasPlaywrightCheckpointImport(cwd: string): Promise<boolean> {
  const checkDirs = ["e2e", "tests", "test", "playwright"];
  const stack = checkDirs.map((dir) => join(cwd, dir));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        // ignore common generated dirs that may appear in fixtures.
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        stack.push(child);
      } else if (
        entry.isFile() &&
        /\.(t|j)sx?$|\.mjs$|\.cjs$/.test(entry.name)
      ) {
        const text = await readText(child);
        if (!text) continue;
        if (PC_IMPORT_RE.test(text) || text.includes("playwright-checkpoint")) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Detect whether Playwright-Checkpoint appears to be in use.
 */
export async function detectPlaywrightCheckpoint(
  cwd: string,
): Promise<boolean> {
  if (await hasPlaywrightCheckpointDependency(cwd)) return true;
  const configPaths = [
    join(cwd, "playwright.config.ts"),
    join(cwd, "playwright.config.js"),
    join(cwd, "playwright.config.mjs"),
  ];
  for (const configPath of configPaths) {
    if (!(await fileExists(configPath))) continue;
    const text = await readText(configPath);
    if (!text) continue;
    if (PC_GLOBAL_TEARDOWN_RE.test(text)) return true;
  }
  return hasPlaywrightCheckpointImport(cwd);
}

// --- Default prompt templates ------------------------------------------

/**
 * Map a step to a default prompt template by tag. Tags are checked in a
 * fixed priority order (e2e > test > typecheck > lint > build) so a step
 * with multiple tags still resolves to a single template. Unknown tags
 * fall back to a generic message.
 */
export function defaultPromptForStep(
  step: Step,
  status: "passed" | "failed",
  options?: { readonly playwrightCheckpoint?: boolean },
): string {
  const tags = new Set(step.tags);
  const kind: DefaultKind = pickDefaultKind(tags);
  const checkpointAware = options?.playwrightCheckpoint ?? false;
  const bucket =
    kind === "e2e" && checkpointAware ? CHECKPOINT_E2E_PROMPTS : DEFAULT_PROMPTS[kind];
  return status === "failed" ? bucket.failure : bucket.success;
}

type DefaultKind = "e2e" | "test" | "typecheck" | "lint" | "build" | "generic";

function pickDefaultKind(tags: ReadonlySet<string>): DefaultKind {
  if (tags.has("e2e")) return "e2e";
  if (tags.has("test")) return "test";
  if (tags.has("typecheck") || tags.has("types")) return "typecheck";
  if (tags.has("lint") || tags.has("format")) return "lint";
  if (tags.has("build")) return "build";
  return "generic";
}

const DEFAULT_PROMPTS: Record<DefaultKind, { success: string; failure: string }> = {
  e2e: {
    success: "End-to-end suite passed. Keep the change.",
    failure:
      "End-to-end tests failed. Read the failure output above, reproduce locally if possible, and fix the regression before continuing.",
  },
  test: {
    success: "Unit tests passed.",
    failure:
      "Unit tests failed. Inspect the failure above and fix the offending code or test before continuing.",
  },
  typecheck: {
    success: "Type check passed.",
    failure:
      "Type check failed. Read the diagnostics above and resolve the type errors before continuing.",
  },
  lint: {
    success: "Lint passed.",
    failure:
      "Lint failed. Read the diagnostics above and fix the reported issues before continuing. Do not suppress rules without a reason.",
  },
  build: {
    success: "Build succeeded.",
    failure:
      "Build failed. Read the compiler output above and resolve the error before continuing.",
  },
  generic: {
    success: "Step passed.",
    failure:
      "Step failed. Read the output above and address the failure before continuing.",
  },
};

const CHECKPOINT_E2E_PROMPTS: Record<
  "success" | "failure",
  string
> = {
  success:
    "E2E passed. Playwright-Checkpoint artifacts are in\n" +
    "test-results/checkpoints/ — it's worth a final pass over the\n" +
    "screenshots and axe.json files for any visual regressions or\n" +
    "accessibility issues that didn't trip an assertion. Report:\n" +
    "./report/index.html",
  failure:
    "Playwright run failed ({summary}). For each failing spec:\n" +
    "\n" +
    "1. Open test-results/html/index.html for the Playwright report.\n" +
    "2. Review the matching checkpoint folder in\n" +
    "   test-results/checkpoints/<spec-name>/ — each checkpoint contains:\n" +
    "   - page.png (screenshot at the checkpoint)\n" +
    "   - axe.json (accessibility audit findings)\n" +
    "   - web-vitals.json (CLS, LCP, FCP, INP, TTFB)\n" +
    "   - console-errors.json (console + page errors since last checkpoint)\n" +
    "   - failed-requests.json (network failures since last checkpoint)\n" +
    "   Check these for regressions that may have caused or contributed\n" +
    "   to the failure beyond the assertion itself.\n" +
    "3. Re-run only the failing specs:\n" +
    '   agent-hooks run e2e --files "<failing-spec-paths>"',
};

// --- Template resolution ------------------------------------------------

interface ResolveTextInput {
  readonly outcome: StepOutcome;
  readonly step: Step;
  readonly cwd: string;
  readonly playwrightCheckpoint: boolean;
  readonly summary: string;
  readonly duration: string;
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly artifacts: readonly string[];
}

function resolveNextText(input: ResolveTextInput): string {
  const status = input.outcome.result?.status;
  if (status !== "passed" && status !== "failed") return "";
  const override =
    status === "passed"
      ? input.step.prompts?.["on-success"]
      : input.step.prompts?.["on-failure"];
  const template = override ?? defaultPromptForStep(input.step, status, {
    playwrightCheckpoint: input.playwrightCheckpoint,
  });
  return applyPromptTemplate(template, {
    step: input.outcome.name,
    status,
    files: formatPromptFiles(input.files),
    artifacts: formatPromptArtifacts(input.artifacts),
    exit_code: String(input.exitCode),
    duration: input.duration,
    cwd: input.cwd,
    summary: input.summary,
  });
}

function formatPromptFiles(files: readonly string[]): string {
  return files.length === 0 ? "" : joinFiles(files);
}

function formatPromptArtifacts(artifacts: readonly string[]): string {
  return artifacts.length === 0 ? "" : artifacts.join(" ");
}

/**
 * Substitute `{step}`, `{status}`, `{exit_code}`, `{duration}`, `{cwd}`,
 * and `{summary}` into a prompt template. Unknown tokens are left
 * untouched so users can still write literal `{foo}` if they really need
 * to — escaping via standard JSON-ish patterns is not worth the
 * complexity at this scale.
 */
export function applyPromptTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    return vars[key] ?? match;
  });
}

// --- Scalar escaping ----------------------------------------------------

/**
 * Emit a YAML-safe scalar for the `summary:` field. Anything with a
 * newline or a leading/trailing quote gets wrapped in double quotes
 * with basic escaping; otherwise we pass it through verbatim.
 */
export function yamlScalar(value: string): string {
  if (value.length === 0) return '""';
  if (/[\n:#]/.test(value) || /^[\s"']/.test(value) || /[\s"']$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
  }
  return value;
}

// --- Context detection --------------------------------------------------

/**
 * Detect the ambient run context from env vars. The caller (run command)
 * uses this to pick the prompt emission policy when no explicit context
 * is passed.
 */
export function detectPromptContext(
  env: Readonly<Record<string, string | undefined>>,
): PromptContext {
  if (env.AGENT_HOOKS_CONTEXT === "agent") return "agent";
  if (env.AGENT_HOOKS_CONTEXT === "ci") return "ci";
  if (env.AGENT_HOOKS_CONTEXT === "tty") return "tty";
  if (env.AGENT_HOOKS_AGENT === "1" || env.AGENT_HOOKS_AGENT === "true") {
    return "agent";
  }
  if (
    env.AGENT_HOOKS_AGENT?.toLowerCase?.() === "yes" ||
    env.AGENT_HOOKS_AGENT?.toLowerCase?.() === "on"
  ) {
    return "agent";
  }
  // Known CI signals.
  if (env.GITHUB_ACTIONS === "true" || env.CI === "true") return "ci";
  // Known agent signals — Claude Code, Cursor, Aider, etc. export these.
  if (
    env.CLAUDE_CODE === "true" ||
    env.CLAUDECODE === "1" ||
    env.CURSOR_TRACE_ID ||
    env.AIDER
  ) {
    return "agent";
  }
  return "tty";
}
