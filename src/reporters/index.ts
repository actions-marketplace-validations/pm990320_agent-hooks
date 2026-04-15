import type { PipelineResult, StepOutcome } from "../runners/pipeline.ts";

/**
 * A reporter receives pipeline lifecycle events and turns them into
 * console output for a specific context (plain console, GitHub Actions,
 * JSON, …). Every reporter is stateless except for its writer.
 */
export interface Reporter {
  pipelineStart(name: string): void;
  stepStart(info: { name: string; tags: readonly string[] }): void;
  stepEnd(outcome: StepOutcome): void;
  pipelineEnd(result: PipelineResult): void;
}

export type Writer = (text: string) => void;

export { createConsoleReporter } from "./console.ts";
export { createGitHubActionsReporter } from "./github-actions.ts";
export { pickReporter } from "./pick.ts";
