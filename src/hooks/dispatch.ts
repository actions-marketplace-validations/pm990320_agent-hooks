import type { Config } from "../config/schema.ts";
import { resolveFiles, type GitRunner } from "../runners/files.ts";
import {
  runPipeline,
  type PipelineResult,
} from "../runners/pipeline.ts";
import type { Reporter, Writer } from "../reporters/index.ts";
import { shouldEmitPrompt } from "../reporters/prompts.ts";
import type { ExecFn } from "../runners/step.ts";
import type { NormalizedHookInput } from "./types.ts";

export interface AgentDispatchOptions {
  readonly agentKey: string;
  readonly hookName: string;
  readonly input: NormalizedHookInput;
  readonly config: Config;
  readonly cwd: string;
  readonly repoRoot?: string;
  readonly env: Record<string, string>;
  readonly git: GitRunner;
  readonly resolvedFiles?: readonly string[];
  readonly exec: ExecFn;
  readonly reporter: Reporter;
  /** Optional stderr writer for agent feedback blocks. */
  readonly writeErr?: Writer;
}

export type AgentDispatchStatus =
  | "no-rule"
  | "no-matcher-match"
  | "pipeline-missing"
  | "ran";

export interface AgentDispatchResult {
  readonly status: AgentDispatchStatus;
  readonly pipelineResult?: PipelineResult;
  readonly exitCode: number;
}

/**
 * Pick the first matching rule from a config.agents.<key>.hooks.<event>
 * array. Matchers are regex patterns over the tool name; rules with no
 * matcher always fire; invalid regexes are silently skipped.
 */
export function pickAgentRule(
  config: Config,
  agentKey: string,
  hookName: string,
  toolName: string | null,
): { pipeline: string } | null {
  const rules = config.agents?.[agentKey]?.hooks?.[hookName];
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
      // Invalid regex — skip this rule, keep iterating.
    }
  }
  return null;
}

function renderAgentFailureBlock(
  outcomeName: string,
  exitCode: number,
  summary: string,
): string {
  return [
    "---agent-hooks:next-step---",
    `step: ${outcomeName}`,
    "status: failed",
    `exit_code: ${String(exitCode)}`,
    `summary: ${summary}`,
    "next: Fix the failure shown above.",
    "---end---",
    "",
  ].join("\n");
}

/**
 * Dispatch a parsed agent hook input to the appropriate pipeline.
 * Used by every agent — the only per-agent variation is in the
 * `parseInput` step that produces the `NormalizedHookInput`.
 */
export async function dispatchAgentHook(
  options: AgentDispatchOptions,
): Promise<AgentDispatchResult> {
  const rules =
    options.config.agents?.[options.agentKey]?.hooks?.[options.hookName];
  if (!rules || rules.length === 0) {
    return { status: "no-rule", exitCode: 0 };
  }

  const rule = pickAgentRule(
    options.config,
    options.agentKey,
    options.hookName,
    options.input.toolName,
  );
  if (!rule) {
    return { status: "no-matcher-match", exitCode: 0 };
  }

  if (!(rule.pipeline in options.config.pipelines)) {
    return { status: "pipeline-missing", exitCode: 2 };
  }

  // Explicit files from the hook payload take precedence; otherwise
  // fall back to the git "changed" scope so Stop/UserPromptSubmit-style
  // hooks still target something meaningful.
  const resolved =
    options.resolvedFiles !== undefined
      ? { scope: "explicit" as const, files: options.resolvedFiles }
      : options.input.files.length > 0
        ? { scope: "explicit" as const, files: options.input.files }
      : await resolveFiles(options.git, { scope: "changed" });

  const result = await runPipeline(
    {
      pipelineName: rule.pipeline,
      config: options.config,
      files: resolved.files,
      cwd: options.cwd,
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
      env: options.env,
      outputMode: "buffered-on-failure",
      onStepEnd: (outcome) => {
        const step = options.config.steps[outcome.name];
        if (
          step &&
          options.writeErr &&
          shouldEmitPrompt(outcome, "failures-only")
        ) {
          options.writeErr(
            renderAgentFailureBlock(
              outcome.name,
              outcome.result?.exitCode ?? 1,
              outcome.result?.reason ??
                `exited ${String(outcome.result?.exitCode ?? 1)}`,
            ),
          );
        }
      },
    },
    options.exec,
  );
  return {
    status: "ran",
    pipelineResult: result,
    exitCode: result.exitCode,
  };
}
