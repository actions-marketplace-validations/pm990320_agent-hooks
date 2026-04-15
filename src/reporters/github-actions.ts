import type { PipelineResult, StepOutcome } from "../runners/pipeline.ts";
import { formatSummary, statusLabel } from "./format.ts";
import type { Reporter, Writer } from "./index.ts";

/**
 * GitHub Actions reporter: wraps each step in ::group::/::endgroup::
 * markers so the web UI collapses step output, and emits ::error::
 * annotations for failed steps. The final summary is still printed so
 * agents and humans reading the raw logs can find the outcome
 * regardless of where they scroll.
 *
 * Known limitation: in parallel mode the group markers don't nest
 * cleanly around concurrently streamed output. CI pipelines almost
 * always run sequentially, so we tolerate this for v1.
 */
export function createGitHubActionsReporter(write: Writer): Reporter {
  return {
    pipelineStart(name) {
      write(`::group::agent-hooks pipeline: ${name}\n`);
    },
    stepStart(info) {
      write(`::group::${info.name}\n`);
    },
    stepEnd(outcome: StepOutcome) {
      write(`::endgroup::\n`);
      if (outcome.kind === "ran" && outcome.result?.status === "failed") {
        const msg = `${outcome.name} ${statusLabel(outcome)}`;
        write(`::error title=${outcome.name}::${msg}\n`);
      }
    },
    pipelineEnd(result: PipelineResult) {
      write(`::endgroup::\n`);
      if (!result.ok) {
        write(
          `::error title=${result.pipelineName}::pipeline failed with exit ${String(result.exitCode)}\n`,
        );
      }
      write(formatSummary(result));
    },
  };
}
