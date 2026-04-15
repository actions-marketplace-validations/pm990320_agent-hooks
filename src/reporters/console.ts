import type { PipelineResult, StepOutcome } from "../runners/pipeline.ts";
import { formatSummary } from "./format.ts";
import type { Reporter, Writer } from "./index.ts";

/**
 * Plain console reporter — the default for interactive runs. Prints the
 * per-step summary at the end. Per-step start/end events are no-ops
 * because step stdout/stderr already stream through inherited pipes.
 */
export function createConsoleReporter(write: Writer): Reporter {
  return {
    pipelineStart(_name) {
      // No-op: the summary header is part of formatSummary.
    },
    stepStart(_info) {
      // No-op: step output streams to the parent's stdio directly.
    },
    stepEnd(_outcome) {
      // No-op.
    },
    pipelineEnd(result: PipelineResult) {
      write(formatSummary(result));
    },
  };
}

// Exported for test convenience — a no-op step-end handler is a common
// assertion target.
export function consoleStepEndIsNoop(_outcome: StepOutcome): void {
  /* intentionally empty */
}
