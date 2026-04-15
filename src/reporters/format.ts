import type { PipelineResult, StepOutcome } from "../runners/pipeline.ts";

/**
 * Shared formatting helpers used by every reporter so the status
 * labels, glyphs, and overall summary stay consistent across contexts.
 */

export function statusGlyph(outcome: StepOutcome): string {
  if (outcome.kind === "excluded-by-tag") return "⊘";
  if (outcome.kind === "skipped-by-flag") return "⊘";
  if (outcome.kind === "skipped-by-gate") return "⊘";
  if (outcome.kind === "skipped-by-area") return "⊘";
  if (outcome.kind === "skipped-by-preflight") return "⚠";
  const result = outcome.result;
  if (!result) return "?";
  if (result.status === "passed") return "✓";
  if (result.status === "failed") return "✗";
  return "⊘";
}

export function statusLabel(outcome: StepOutcome): string {
  if (outcome.kind === "excluded-by-tag") {
    return `excluded (${outcome.reason ?? "tag filter"})`;
  }
  if (outcome.kind === "skipped-by-flag") {
    return `skipped (${outcome.reason ?? "flag"})`;
  }
  if (outcome.kind === "skipped-by-gate") {
    return `skipped by gate (${outcome.reason ?? "no matching changes"})`;
  }
  if (outcome.kind === "skipped-by-area") {
    return `skipped by area (${outcome.reason ?? "no matching areas"})`;
  }
  if (outcome.kind === "skipped-by-preflight") {
    return `SKIPPED (missing: ${outcome.reason ?? "preflight"})`;
  }
  const result = outcome.result;
  if (!result) return "unknown";
  if (result.status === "skipped") {
    return `skipped (${result.reason ?? ""})`;
  }
  if (result.status === "failed") {
    return `failed (exit ${String(result.exitCode)})`;
  }
  return "passed";
}

export function stepDurationSeconds(outcome: StepOutcome): string | null {
  if (!outcome.result) return null;
  return (outcome.result.durationMs / 1000).toFixed(2);
}

export function pipelineDurationSeconds(result: PipelineResult): string {
  return (result.durationMs / 1000).toFixed(2);
}

export function overallTag(result: PipelineResult): string {
  return result.ok ? "ok" : `failed (exit ${String(result.exitCode)})`;
}

export function formatSummary(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push(`— pipeline: ${result.pipelineName}`);
  for (const outcome of result.steps) {
    const duration = stepDurationSeconds(outcome);
    const durationText = duration ? ` (${duration}s)` : "";
    lines.push(
      `  ${statusGlyph(outcome)} ${outcome.name}${durationText} — ${statusLabel(outcome)}`,
    );
  }
  lines.push(`— ${overallTag(result)} in ${pipelineDurationSeconds(result)}s`);
  return `${lines.join("\n")}\n`;
}
