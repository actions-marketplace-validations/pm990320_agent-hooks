/**
 * Beads pre-commit auto-staging (PLAN §7).
 *
 * When a repo uses Beads, changes to `.beads/*` are usually generated
 * by the agent or `bd` as a side-effect of whatever work the user is
 * about to commit. Requiring the user to `git add .beads/` after the
 * fact is a paper cut that breaks commits into two steps. This module
 * folds those changes into the in-progress commit automatically —
 * unless the user opted out via `beads.pre-commit`.
 *
 * Behavior per config value:
 *
 *   - `stage` (default): list modified `.beads/*` paths and stage them
 *     with `git add --`, then log what we staged.
 *   - `warn`: log a heads-up that `.beads/*` has unstaged changes,
 *     but don't touch the index.
 *   - `off`: no-op.
 *
 * The module is pure up to the `GitRunner` methods it uses, so tests
 * can swap in an in-memory runner with no git binary involved.
 */

import type { Config } from "../../config/schema.ts";
import type { GitRunner } from "../../runners/files.ts";
import { detectBeads, type BeadsFs } from "./detect.ts";

export type BeadsPreCommitMode = "stage" | "warn" | "off";
export type BeadsPreCommitAction = "staged" | "warned" | "noop";

export interface BeadsPreCommitInput {
  readonly cwd: string;
  readonly config: Config;
  readonly git: GitRunner;
  readonly fs: BeadsFs;
  /** Writer for the single status line the stager emits. */
  readonly write: (text: string) => void;
}

export interface BeadsPreCommitOutcome {
  readonly action: BeadsPreCommitAction;
  readonly files: readonly string[];
}

/**
 * Run the pre-commit auto-stager. Bails out cleanly if Beads isn't
 * enabled (via `beads.enabled: false` or no `.beads/` dir), or if the
 * `GitRunner` doesn't expose the `modifiedUnder`/`stage` methods (old
 * test stubs).
 */
export async function autoStageBeadsChanges(
  input: BeadsPreCommitInput,
): Promise<BeadsPreCommitOutcome> {
  const mode: BeadsPreCommitMode =
    input.config.beads?.["pre-commit"] ?? "stage";
  if (mode === "off") {
    return { action: "noop", files: [] };
  }

  const detection = await detectBeads(
    input.cwd,
    input.config.beads?.enabled,
    input.fs,
  );
  if (!detection.enabled) {
    return { action: "noop", files: [] };
  }

  // A GitRunner stub without `modifiedUnder` can't answer the question —
  // silently noop so tests without beads integration don't need to fake
  // the method.
  if (!input.git.modifiedUnder) {
    return { action: "noop", files: [] };
  }
  const changes = await input.git.modifiedUnder(".beads");
  if (changes.length === 0) {
    return { action: "noop", files: [] };
  }

  if (mode === "warn") {
    input.write(
      `  ⚠ beads: ${String(changes.length)} unstaged .beads/ change(s) — commit will not include them\n`,
    );
    return { action: "warned", files: changes };
  }

  // mode === "stage"
  if (!input.git.stage) {
    input.write(
      `  ⚠ beads: would stage ${String(changes.length)} .beads/ change(s) but the git runner can't stage\n`,
    );
    return { action: "warned", files: changes };
  }
  await input.git.stage(changes);
  input.write(
    `  + beads: staged ${String(changes.length)} .beads/ change(s)\n`,
  );
  return { action: "staged", files: changes };
}
