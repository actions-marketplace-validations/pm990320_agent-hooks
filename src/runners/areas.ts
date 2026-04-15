/**
 * Area maps (PLAN §5.7) — a per-step selector that rewrites the file
 * list based on which *logical areas* the incoming changes touched. The
 * classic shape looks like:
 *
 *     areas:
 *       schemas:
 *         when: schemas/**
 *         run: [api/, workers/]
 *       frontend:
 *         when: web/**
 *         run: web/
 *     unmatched: skip
 *
 * Read this as: "if any file under `schemas/**` changed, run the step
 * against `api/` and `workers/` instead; if `web/**` changed, run it
 * against `web/`; if nothing matched, skip the step." The `run` values
 * are literal selector strings the step's command template substitutes
 * in for `{files}` — they're not globbed against a universe.
 *
 * This module is deliberately free of fs access: it's a pure decision
 * helper over the incoming file list + the step's areas config. The
 * step runner calls it once before dispatching on `invocation`.
 */

import picomatch from "picomatch";
import type { Step } from "../config/schema.ts";

export type AreaDecisionKind =
  | "passthrough"
  | "rewrite"
  | "skip"
  | "project";

export interface AreaDecision {
  readonly kind: AreaDecisionKind;
  /** Selector strings to substitute for `{files}` (rewrite only). */
  readonly files: readonly string[];
  /** Area names that matched — used by reporters and logs. */
  readonly matchedAreas: readonly string[];
  /** Short human-readable explanation for logs / outcome reasons. */
  readonly reason?: string;
}

/**
 * Decide how a step's incoming file list should be rewritten based on
 * its area map. Returns `null` when the step doesn't declare any areas
 * (the caller should leave the list untouched).
 *
 * Decision kinds:
 *
 *   - `passthrough`: at least one area matched and its `run` entries
 *     are used as the new selectors. Step runs.
 *   - `rewrite`: alias for passthrough — the incoming files are
 *     replaced with the union of `run` globs from matched areas.
 *   - `skip`: no area matched and `unmatched: skip` (default-ish).
 *   - `project`: no area matched and `unmatched: all` — fall through
 *     to the step's project variant.
 *
 * `unmatched: smoke` uses the `smoke` area's run globs unconditionally
 * as a fallback "always run this lite subset" target.
 */
export function resolveAreas(
  step: Step,
  incomingFiles: readonly string[],
): AreaDecision | null {
  const areas = step.areas;
  if (!areas || Object.keys(areas).length === 0) return null;

  const matched: string[] = [];
  const selectors: string[] = [];
  for (const [name, area] of Object.entries(areas)) {
    const whenGlobs = toArray(area.when);
    if (anyFileMatches(incomingFiles, whenGlobs)) {
      matched.push(name);
      for (const sel of toArray(area.run)) {
        if (!selectors.includes(sel)) selectors.push(sel);
      }
    }
  }

  if (matched.length > 0) {
    return {
      kind: "rewrite",
      files: selectors,
      matchedAreas: matched,
      reason: `areas matched: ${matched.join(", ")}`,
    };
  }

  // No area matched — consult `unmatched:` to decide what to do.
  const unmatched = step.unmatched ?? "skip";
  if (unmatched === "skip") {
    return {
      kind: "skip",
      files: [],
      matchedAreas: [],
      reason: "no areas matched",
    };
  }
  if (unmatched === "all") {
    return {
      kind: "project",
      files: [],
      matchedAreas: [],
      reason: "no areas matched; running project variant",
    };
  }
  // unmatched: smoke — use the `smoke` area's run globs unconditionally.
  const smoke = areas.smoke;
  if (!smoke) {
    // `unmatched: smoke` but no smoke area defined: treat like skip so
    // the user gets a visible signal to fix their config rather than
    // a silent full-project run.
    return {
      kind: "skip",
      files: [],
      matchedAreas: [],
      reason: 'unmatched: smoke but no "smoke" area defined',
    };
  }
  return {
    kind: "rewrite",
    files: toArray(smoke.run),
    matchedAreas: ["smoke"],
    reason: "no areas matched; using smoke fallback",
  };
}

// --- helpers -------------------------------------------------------------

function toArray(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

function anyFileMatches(
  files: readonly string[],
  globs: readonly string[],
): boolean {
  if (globs.length === 0) return false;
  const matchers = globs.map((g) => picomatch(g, { dot: true }));
  return files.some((f) => matchers.some((m) => m(f)));
}
