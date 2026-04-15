import type { Config } from "../../config/schema.ts";
import { resolveFiles, type GitRunner } from "../../runners/files.ts";
import {
  runPipeline,
  type PipelineResult,
} from "../../runners/pipeline.ts";
import type { Reporter } from "../../reporters/index.ts";
import type { ExecFn } from "../../runners/step.ts";
import type { ClaudeHookInput } from "./input.ts";

/**
 * Resolve which rule from `agents.claude-code.hooks.<HookName>` should
 * fire for this input. First matching `matcher` wins; rules without a
 * matcher always fire. Matchers are compiled as regexes over the
 * tool name.
 */
export function pickClaudeRule(
  config: Config,
  hookName: string,
  toolName: string | null,
): { pipeline: string } | null {
  const rules = config.agents?.["claude-code"]?.hooks?.[hookName];
  if (!rules || rules.length === 0) return null;

  for (const rule of rules) {
    if (rule.matcher === undefined) {
      return { pipeline: rule.pipeline };
    }
    if (toolName === null) continue;
    try {
      const re = new RegExp(rule.matcher);
      if (re.test(toolName)) return { pipeline: rule.pipeline };
    } catch {
      // Invalid regex — treat as non-matching but keep iterating.
    }
  }
  return null;
}

export interface ClaudeDispatchOptions {
  readonly hookName: string;
  readonly input: ClaudeHookInput;
  readonly config: Config;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly git: GitRunner;
  readonly exec: ExecFn;
  readonly reporter: Reporter;
}

export type ClaudeDispatchStatus =
  | "no-rule"
  | "no-matcher-match"
  | "pipeline-missing"
  | "ran";

export interface ClaudeDispatchResult {
  readonly status: ClaudeDispatchStatus;
  readonly pipelineResult?: PipelineResult;
  readonly exitCode: number;
}

export async function dispatchClaudeHook(
  options: ClaudeDispatchOptions,
): Promise<ClaudeDispatchResult> {
  const rules = options.config.agents?.["claude-code"]?.hooks?.[options.hookName];
  if (!rules || rules.length === 0) {
    return { status: "no-rule", exitCode: 0 };
  }

  const rule = pickClaudeRule(
    options.config,
    options.hookName,
    options.input.toolName,
  );
  if (!rule) {
    return { status: "no-matcher-match", exitCode: 0 };
  }

  if (!(rule.pipeline in options.config.pipelines)) {
    return { status: "pipeline-missing", exitCode: 2 };
  }

  // If Claude provided files, use them as the explicit scope. Otherwise
  // fall back to "changed" so Stop/UserPromptSubmit style hooks still
  // target something meaningful.
  const resolved =
    options.input.files.length > 0
      ? { scope: "explicit" as const, files: options.input.files }
      : await resolveFiles(options.git, { scope: "changed" });

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
  };
}
