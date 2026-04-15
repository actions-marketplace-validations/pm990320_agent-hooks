import type {
  Detector,
  DetectorContext,
  DetectorFragment,
} from "./types.ts";
import { DETECTORS } from "./registry.ts";

/**
 * Fragment shape after merging — same as DetectorFragment but with
 * all record fields present and an ordered list of notes.
 */
export interface MergedFragment {
  readonly steps: Record<string, NonNullable<DetectorFragment["steps"]>[string]>;
  readonly pipelines: Record<
    string,
    NonNullable<DetectorFragment["pipelines"]>[string]
  >;
  readonly gitHooks: Record<
    string,
    NonNullable<DetectorFragment["gitHooks"]>[string]
  >;
  readonly detectorNames: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Run every registered detector against the given cwd and merge their
 * fragments into a single MergedFragment. Step-name collisions between
 * detectors get prefixed with the later detector's name (first wins).
 * Pipelines with the same name union their step lists, dedup-ing
 * references but preserving order.
 */
export async function mergeDetectors(
  ctx: DetectorContext,
  detectors: readonly Detector[] = DETECTORS,
): Promise<MergedFragment> {
  const steps: MergedFragment["steps"] = {};
  const pipelines: MergedFragment["pipelines"] = {};
  const gitHooks: MergedFragment["gitHooks"] = {};
  const detectorNames: string[] = [];
  const notes: string[] = [];

  for (const detector of detectors) {
    if (!(await detector.detect(ctx))) continue;
    detectorNames.push(detector.name);
    const fragment = await detector.template(ctx);

    // Steps: first wins. Collisions get `<detector>:<step>` prefix.
    for (const [name, step] of Object.entries(fragment.steps ?? {})) {
      const key = name in steps ? `${detector.name}:${name}` : name;
      steps[key] = step;
    }

    // Pipelines: union of step references, preserving order + dedup.
    for (const [name, pipeline] of Object.entries(fragment.pipelines ?? {})) {
      const existing = pipelines[name];
      if (!existing) {
        pipelines[name] = pipeline;
        continue;
      }
      const seen = new Set(existing.steps);
      const merged: string[] = [...existing.steps];
      for (const step of pipeline.steps) {
        if (!seen.has(step)) {
          seen.add(step);
          merged.push(step);
        }
      }
      // Merge tag-exclusion lists too — union.
      const excludeSeen = new Set([
        ...(existing["exclude-tags"] ?? []),
        ...(pipeline["exclude-tags"] ?? []),
      ]);
      pipelines[name] = {
        steps: merged,
        ...(existing.parallel !== undefined
          ? { parallel: existing.parallel }
          : pipeline.parallel !== undefined
            ? { parallel: pipeline.parallel }
            : {}),
        ...(excludeSeen.size > 0
          ? { "exclude-tags": [...excludeSeen] }
          : {}),
      };
    }

    // Git hooks: first wins. Later detectors don't clobber.
    for (const [name, hook] of Object.entries(fragment.gitHooks ?? {})) {
      if (!(name in gitHooks)) {
        gitHooks[name] = hook;
      }
    }

    for (const note of fragment.notes ?? []) {
      notes.push(note);
    }
  }

  return { steps, pipelines, gitHooks, detectorNames, notes };
}
