import type { Config, Pipeline, Step } from "../config/schema.ts";
import { evaluateGate } from "./change-gates.ts";
import { filterByGlob, type GitRunner } from "./files.ts";
import {
  defaultPreflightResolver,
  evaluatePreflight,
  resolvePreflightPolicy,
  type PreflightContext,
  type PreflightResolver,
} from "./preflight.ts";
import { runStep, type ExecFn, type StepResult } from "./step.ts";

export interface PipelineOptions {
  readonly pipelineName: string;
  readonly config: Config;
  /** File list after scope resolution but before per-step glob filtering. */
  readonly files: readonly string[];
  /** True when the caller asked for a project-scope run (e.g. `--all`). */
  readonly projectForced?: boolean;
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /** Step names to skip. Overrides pipeline tag filters. */
  readonly skip?: ReadonlySet<string>;
  /** If set, only these step names run. */
  readonly only?: ReadonlySet<string>;
  /** Override pipeline.parallel. Used by --jobs N. */
  readonly jobs?: number;
  /**
   * GitRunner used by change-gated steps. Omit if your config doesn't
   * use `when-changed` — gates are then left unevaluated (never skip).
   */
  readonly git?: GitRunner;
  /** Bypass all change gates and run every step regardless. */
  readonly forceGates?: boolean;
  /**
   * Context that drives the default `on-missing` policy when a step
   * doesn't override it. Defaults to "manual" (CLI invocations), which
   * fails on missing prereqs. Hook contexts pass "git-hook" or
   * "agent-hook" to get the warn-skip default.
   */
  readonly preflightContext?: PreflightContext;
  /** Resolver for command/file/env preflight checks. */
  readonly preflightResolver?: PreflightResolver;
  /** Called just before a step's command is executed. */
  readonly onStepStart?: (info: { name: string; tags: readonly string[] }) => void;
  /** Called after a step finishes (or is skipped by the step runner). */
  readonly onStepEnd?: (outcome: StepOutcome) => void;
}

export type StepOutcomeKind =
  | "ran"
  | "excluded-by-tag"
  | "skipped-by-flag"
  | "skipped-by-area"
  | "skipped-by-gate"
  | "skipped-by-preflight";

export interface StepOutcome {
  readonly name: string;
  readonly kind: StepOutcomeKind;
  readonly tags: readonly string[];
  readonly result?: StepResult;
  readonly reason?: string;
}

export interface PipelineResult {
  readonly pipelineName: string;
  readonly ok: boolean;
  readonly exitCode: number;
  readonly steps: readonly StepOutcome[];
  readonly durationMs: number;
}

export class PipelineError extends Error {
  readonly code: "not-found" | "missing-step";
  constructor(message: string, code: PipelineError["code"]) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
  }
}

interface StepEntry {
  readonly name: string;
  readonly step: Step;
}

function resolveSteps(config: Config, pipeline: Pipeline): StepEntry[] {
  return pipeline.steps.map((name) => {
    const step = config.steps[name];
    if (!step) {
      throw new PipelineError(
        `pipeline references undefined step "${name}"`,
        "missing-step",
      );
    }
    return { name, step };
  });
}

function hasAnyTag(
  step: Step,
  tags: readonly string[],
): boolean {
  if (tags.length === 0) return false;
  const tagSet = new Set(tags);
  return step.tags.some((t) => tagSet.has(t));
}

interface FilterResult {
  readonly kept: StepEntry[];
  readonly outcomes: StepOutcome[];
}

/**
 * Apply include-tags, exclude-tags, --skip, and --only filters. Returns
 * both the kept steps and pre-built StepOutcome entries for the ones we
 * dropped, so the caller can emit them in summary order alongside the
 * ones that actually ran.
 */
export function applyFilters(
  entries: readonly StepEntry[],
  pipeline: Pipeline,
  options: { skip?: ReadonlySet<string>; only?: ReadonlySet<string> },
): FilterResult {
  const kept: StepEntry[] = [];
  const outcomes: StepOutcome[] = [];

  for (const entry of entries) {
    const { name, step } = entry;

    if (options.only && !options.only.has(name)) {
      outcomes.push({
        name,
        kind: "skipped-by-flag",
        tags: step.tags,
        reason: "not in --only list",
      });
      continue;
    }
    if (options.skip?.has(name)) {
      outcomes.push({
        name,
        kind: "skipped-by-flag",
        tags: step.tags,
        reason: "--skip",
      });
      continue;
    }
    if (
      pipeline["include-tags"].length > 0 &&
      !hasAnyTag(step, pipeline["include-tags"])
    ) {
      outcomes.push({
        name,
        kind: "excluded-by-tag",
        tags: step.tags,
        reason: `no tag in include-tags (${pipeline["include-tags"].join(", ")})`,
      });
      continue;
    }
    if (
      pipeline["exclude-tags"].length > 0 &&
      hasAnyTag(step, pipeline["exclude-tags"])
    ) {
      outcomes.push({
        name,
        kind: "excluded-by-tag",
        tags: step.tags,
        reason: `matches exclude-tag (${pipeline["exclude-tags"].filter((t) => step.tags.includes(t)).join(", ")})`,
      });
      continue;
    }

    kept.push(entry);
  }

  return { kept, outcomes };
}

// --- Main pipeline runner ------------------------------------------------

async function runOneStep(
  entry: StepEntry,
  options: PipelineOptions,
  exec: ExecFn,
  outputMode: "inherit" | "buffered",
): Promise<StepOutcome> {
  // Change-gate check: before firing onStepStart, decide whether this
  // step should run at all. `forceGates` bypasses.
  if (!options.forceGates && options.git && entry.step["when-changed"]) {
    const decision = await evaluateGate(entry.step, options.git);
    if (decision && !decision.shouldRun) {
      const outcome: StepOutcome = {
        name: entry.name,
        kind: "skipped-by-gate",
        tags: entry.step.tags,
        reason: decision.reason,
      };
      options.onStepEnd?.(outcome);
      return outcome;
    }
  }

  // Preflight: validate the step's `requires` block before exec. The
  // `on-missing` policy decides whether a missing dep fails the step
  // (manual/CI default), warn-skips it (hook default), or just warns.
  if (entry.step.requires.length > 0) {
    const resolver = options.preflightResolver ?? defaultPreflightResolver;
    const decision = await evaluatePreflight(
      entry.step,
      options.cwd,
      resolver,
    );
    if (!decision.ok) {
      const policy = resolvePreflightPolicy(
        entry.step,
        options.preflightContext ?? "manual",
      );
      const reasons = decision.failures.map((f) => f.reason).join("; ");
      if (policy === "fail") {
        const outcome: StepOutcome = {
          name: entry.name,
          kind: "ran",
          tags: entry.step.tags,
          result: {
            status: "failed",
            exitCode: 3,
            invocations: [],
            reason: `preflight: ${reasons}`,
            durationMs: 0,
          },
        };
        options.onStepEnd?.(outcome);
        return outcome;
      }
      if (policy === "warn-skip" || policy === "skip") {
        const outcome: StepOutcome = {
          name: entry.name,
          kind: "skipped-by-preflight",
          tags: entry.step.tags,
          reason: reasons,
        };
        options.onStepEnd?.(outcome);
        return outcome;
      }
      // policy === "warn" → fall through and run the step anyway, but
      // surface the warning via onStepStart in the same payload.
    }
  }

  options.onStepStart?.({ name: entry.name, tags: entry.step.tags });
  const filtered = filterByGlob(options.files, entry.step.files);
  const result = await runStep(
    {
      name: entry.name,
      step: entry.step,
      files: filtered,
      projectForced: options.projectForced ?? false,
      cwd: options.cwd,
      output: outputMode,
      ...(options.env ? { env: options.env } : {}),
    },
    exec,
  );
  const skippedByArea =
    result.status === "skipped" &&
    result.area?.kind === "skip";
  const outcome: StepOutcome = {
    name: entry.name,
    kind: skippedByArea ? "skipped-by-area" : "ran",
    tags: entry.step.tags,
    result,
  };
  options.onStepEnd?.(outcome);
  return outcome;
}

async function runSequentially(
  kept: readonly StepEntry[],
  options: PipelineOptions,
  exec: ExecFn,
  continueOnError: boolean,
): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (const entry of kept) {
    // Sequential: child stdio inherits parent → live streaming, no
    // memory pressure from buffering long output.
    const outcome = await runOneStep(entry, options, exec, "inherit");
    outcomes.push(outcome);
    if (!continueOnError && outcome.result && outcome.result.exitCode !== 0) {
      // Stop on first failure.
      return outcomes;
    }
  }
  return outcomes;
}

async function runInParallel(
  kept: readonly StepEntry[],
  options: PipelineOptions,
  exec: ExecFn,
  jobs: number,
): Promise<StepOutcome[]> {
  const queue = [...kept];
  const outcomes: (StepOutcome | undefined)[] = Array.from({
    length: kept.length,
  });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = queue[index];
      if (entry === undefined) return;
      // Parallel: buffer per step so two concurrent children don't
      // interleave on the parent's FDs. Flushed atomically on step end.
      outcomes[index] = await runOneStep(entry, options, exec, "buffered");
    }
  }

  const workerCount = Math.max(1, Math.min(jobs, kept.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return outcomes.filter((o): o is StepOutcome => o !== undefined);
}

export async function runPipeline(
  options: PipelineOptions,
  exec: ExecFn,
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const pipeline = options.config.pipelines[options.pipelineName];
  if (!pipeline) {
    throw new PipelineError(
      `pipeline "${options.pipelineName}" not defined`,
      "not-found",
    );
  }

  const allEntries = resolveSteps(options.config, pipeline);
  const { kept, outcomes: filterOutcomes } = applyFilters(allEntries, pipeline, {
    ...(options.skip ? { skip: options.skip } : {}),
    ...(options.only ? { only: options.only } : {}),
  });

  const runOutcomes = pipeline.parallel
    ? await runInParallel(kept, options, exec, options.jobs ?? kept.length)
    : await runSequentially(
        kept,
        options,
        exec,
        pipeline["continue-on-error"],
      );

  // Re-order outcomes to match the original step order so summaries are
  // readable regardless of filter/parallelism.
  const byName = new Map<string, StepOutcome>();
  for (const o of filterOutcomes) byName.set(o.name, o);
  for (const o of runOutcomes) byName.set(o.name, o);
  const ordered = pipeline.steps
    .map((name) => byName.get(name))
    .filter((o): o is StepOutcome => o !== undefined);

  const exitCode = ordered.reduce((max, o) => {
    if (o.kind !== "ran" || !o.result) return max;
    return Math.max(max, o.result.exitCode);
  }, 0);

  return {
    pipelineName: options.pipelineName,
    ok: exitCode === 0,
    exitCode,
    steps: ordered,
    durationMs: Date.now() - startedAt,
  };
}
