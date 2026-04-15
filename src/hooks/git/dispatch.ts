import type { Config } from "../../config/schema.ts";
import nodeFs from "node:fs/promises";
import {
  autoStageBeadsChanges,
  type BeadsPreCommitOutcome,
} from "../../integrations/beads/pre-commit.ts";
import type { BeadsFs } from "../../integrations/beads/detect.ts";
import { resolveFiles, type GitRunner } from "../../runners/files.ts";
import {
  runPipeline,
  type PipelineResult,
} from "../../runners/pipeline.ts";
import type { ExecFn } from "../../runners/step.ts";
import type { Reporter } from "../../reporters/index.ts";

/**
 * Which file-scope strategy to use for each git hook name. This is how
 * we translate "pre-commit runs" into the right file list without
 * making every user spell it out in their config.
 */
export function scopeForGitHook(hookName: string): "staged" | "changed" | "all" {
  switch (hookName) {
    case "pre-commit":
    case "prepare-commit-msg":
    case "commit-msg":
      return "staged";
    case "pre-push":
    case "post-merge":
    case "post-checkout":
    case "post-rewrite":
      return "changed";
    default:
      return "all";
  }
}

export interface GitHookDispatchOptions {
  readonly hookName: string;
  readonly config: Config;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly git: GitRunner;
  readonly exec: ExecFn;
  readonly reporter: Reporter;
  /** Writer for operational messages (auto-staging, diagnostics). */
  readonly write?: (text: string) => void;
  /** Filesystem adapter used by the beads pre-commit stager. */
  readonly beadsFs?: BeadsFs;
}

export interface GitHookDispatchResult {
  readonly status: "no-rule" | "ran" | "pipeline-missing";
  readonly pipelineResult?: PipelineResult;
  readonly exitCode: number;
  /** Describes what (if anything) the beads auto-stager did. */
  readonly beads?: BeadsPreCommitOutcome;
}

function noopWriter(_text: string): void {
  /* swallow — dispatch callers without a writer don't see beads log */
}

const defaultBeadsFs: BeadsFs = {
  async exists(p) {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Resolve which pipeline a git hook should run, fetch the matching file
 * scope, and invoke the pipeline runner. Returns a structured result so
 * the CLI layer can decide exit codes and error messages.
 */
export async function dispatchGitHook(
  options: GitHookDispatchOptions,
): Promise<GitHookDispatchResult> {
  const rule = options.config.git?.hooks?.[options.hookName];
  if (!rule) {
    // No rule for this hook — git may still invoke the stub because
    // an older config hash is on disk. Treat it as a no-op success.
    return { status: "no-rule", exitCode: 0 };
  }

  if (!(rule.pipeline in options.config.pipelines)) {
    return { status: "pipeline-missing", exitCode: 2 };
  }

  // Beads auto-stage runs on pre-commit only, *before* we resolve the
  // staged file list. That way any files the stager adds land in the
  // same `git diff --cached` result the pipeline sees — the commit and
  // the pipeline can't see different snapshots of the index.
  let beads: BeadsPreCommitOutcome | undefined;
  if (options.hookName === "pre-commit") {
    beads = await autoStageBeadsChanges({
      cwd: options.cwd,
      config: options.config,
      git: options.git,
      fs: options.beadsFs ?? defaultBeadsFs,
      write: options.write ?? noopWriter,
    });
  }

  const scope = scopeForGitHook(options.hookName);
  const resolved = await resolveFiles(options.git, { scope });

  options.reporter.pipelineStart(rule.pipeline);
  const result = await runPipeline(
    {
      pipelineName: rule.pipeline,
      config: options.config,
      files: resolved.files,
      cwd: options.cwd,
      env: options.env,
      onStepStart: (info) => options.reporter.stepStart(info),
      onStepEnd: (outcome) => options.reporter.stepEnd(outcome),
    },
    options.exec,
  );
  options.reporter.pipelineEnd(result);

  return {
    status: "ran",
    pipelineResult: result,
    exitCode: result.exitCode,
    ...(beads ? { beads } : {}),
  };
}
