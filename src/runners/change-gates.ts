import { createHash } from "node:crypto";
import picomatch from "picomatch";
import type { Step } from "../config/schema.ts";
import type { GitRunner } from "./files.ts";

/**
 * Filesystem adapter used by the last-run cache. Injected so tests can
 * run against an in-memory map.
 */
export interface GateCacheFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string): Promise<void>;
  mkdirRecursive(p: string): Promise<void>;
}

/**
 * Decide whether a change-gated step should run based on its
 * `when-changed` block and the `git` runner's diff output.
 *
 * - `since: head` → diff staged + unstaged vs HEAD (uses staged() +
 *   changed() union). We only care about whether at least one path
 *   matches the watch globs.
 * - `since: merge-base` → diff vs merge-base with default branch.
 *
 * Returns `{ shouldRun, reason }` so callers can surface a meaningful
 * message for skipped gates.
 */
export interface GateDecision {
  readonly shouldRun: boolean;
  readonly reason: string;
}

function normalizePaths(paths: string | readonly string[]): string[] {
  if (typeof paths === "string") return [paths];
  return [...paths];
}

async function listChangedFiles(
  git: GitRunner,
  since: "head" | "merge-base",
): Promise<readonly string[]> {
  if (since === "merge-base") {
    return git.changed();
  }
  // "head" — everything that differs from HEAD in the working tree:
  // staged + unstaged. git's own concept: diff and diff --cached.
  const staged = await git.staged();
  // GitRunner only exposes staged/changed/all; "changed" (vs merge-base)
  // overlaps with unstaged changes on-branch, but not strictly. For the
  // v0.1 slice we conservatively union staged + changed. Tests document
  // this behavior.
  //
  // In CI contexts (detached HEAD, no origin/main, no local main/master
  // after actions/checkout with default fetch-depth: 1), git.changed()
  // throws UnresolvableBaseRefError. For since: "head" the merge-base
  // comparison isn't semantically required — staged already captures
  // the PR's committed changes vs HEAD for the shallow-checkout case.
  // Degrade gracefully rather than crashing the pipeline.
  let changed: readonly string[] = [];
  try {
    changed = await git.changed();
  } catch {
    // No merge-base base ref available. Keep `staged` only.
  }
  const union = new Set<string>();
  for (const p of staged) union.add(p);
  for (const p of changed) union.add(p);
  return [...union];
}

export interface EvaluateGateOptions {
  readonly stepName: string;
  readonly step: Step;
  readonly git: GitRunner;
  /** Absolute path to the repo root — used by the last-run cache. */
  readonly cwd: string;
  /**
   * The pipeline's resolved input file list — from the hook payload,
   * `--files`, `--staged`, `--all`, etc. When provided, the gate
   * checks whether any of these files match the `when-changed.paths`
   * patterns directly, WITHOUT calling git. This is the correct
   * behavior for agent hooks (the payload IS the authoritative list
   * of what changed) and for every other invocation mode (the scope
   * resolution already determined what files are "in play").
   *
   * Falls back to git-based detection only when this is undefined
   * (legacy callers that haven't been updated to pass files).
   */
  readonly inputFiles?: readonly string[];
  /** Filesystem adapter for the last-run cache. Only needed for `since: last-run`. */
  readonly cacheFs?: GateCacheFs;
  /** How to read a watch-path file's content when hashing for last-run. */
  readonly readWatchPath?: (absPath: string) => Promise<string | null>;
}

/**
 * Compute the SHA256 of all watch paths' current contents, joined with
 * null separators so reordering doesn't produce the same hash.
 */
async function hashWatchPaths(
  watchPaths: readonly string[],
  cwd: string,
  read: (absPath: string) => Promise<string | null>,
): Promise<string> {
  const hasher = createHash("sha256");
  for (const rel of [...watchPaths].sort()) {
    const abs = `${cwd}/${rel}`;
    const contents = await read(abs);
    hasher.update(rel);
    hasher.update("\0");
    hasher.update(contents ?? "\u0000");
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function cachePath(cwd: string, stepName: string): string {
  return `${cwd}/.agent-hooks/state/${stepName}.hash`;
}

export async function evaluateGate(
  stepOrOptions: Step | EvaluateGateOptions,
  git?: GitRunner,
): Promise<GateDecision | null> {
  // Back-compat shim: older callers pass (step, git) directly. Normalize.
  const options: EvaluateGateOptions =
    "step" in stepOrOptions
      ? stepOrOptions
      : {
          stepName: "unknown",
          step: stepOrOptions,
          git: git!,
          cwd: process.cwd(),
        };

  const gate = options.step["when-changed"];
  if (!gate) return null;

  const watch = normalizePaths(gate.paths);
  const matchers = watch.map((glob) => picomatch(glob, { dot: true }));

  // When input files are provided (hook payload, --files, --staged,
  // --all), match against those directly. No git call needed — the
  // caller already resolved what's "in scope" and the gate just
  // filters on it. This is critical for agent hooks where the payload
  // IS the authoritative list of what the agent just changed.
  if (options.inputFiles !== undefined) {
    const hit = options.inputFiles.some((file) =>
      matchers.some((match) => match(file)),
    );
    if (hit) {
      return { shouldRun: true, reason: "matched input files" };
    }
    return {
      shouldRun: false,
      reason: `no input files matched ${watch.join(", ")}`,
    };
  }

  if (gate.since === "last-run") {
    const fs = options.cacheFs;
    const readFile = options.readWatchPath;
    if (!fs || !readFile) {
      // Without a cache fs, we can't evaluate last-run. Treat as "always
      // run" so users opting into last-run without wiring the cache still
      // get correct behavior rather than silently skipping forever.
      return {
        shouldRun: true,
        reason: "last-run cache not available — running",
      };
    }
    const hashPath = cachePath(options.cwd, options.stepName);
    const current = await hashWatchPaths(watch, options.cwd, readFile);
    if (await fs.exists(hashPath)) {
      const previous = (await fs.read(hashPath)).trim();
      if (previous === current) {
        return {
          shouldRun: false,
          reason: `last-run hash unchanged (${previous.slice(0, 8)}…)`,
        };
      }
    }
    return {
      shouldRun: true,
      reason: `last-run hash changed`,
    };
  }

  const changed = await listChangedFiles(options.git, gate.since);
  const hit = changed.some((file) =>
    matchers.some((match) => match(file)),
  );

  if (hit) {
    return {
      shouldRun: true,
      reason: `matched watch pattern`,
    };
  }
  return {
    shouldRun: false,
    reason: `no changes under ${watch.join(", ")} since ${gate.since}`,
  };
}

/**
 * Persist the successful-run hash for a gate. Called by the pipeline
 * runner after a gated step passes.
 */
export async function recordGateRun(
  options: EvaluateGateOptions,
): Promise<void> {
  const gate = options.step["when-changed"];
  if (gate?.since !== "last-run") return;
  const fs = options.cacheFs;
  const readFile = options.readWatchPath;
  if (!fs || !readFile) return;
  const watch = normalizePaths(gate.paths);
  const hash = await hashWatchPaths(watch, options.cwd, readFile);
  const hashPath = cachePath(options.cwd, options.stepName);
  await fs.mkdirRecursive(`${options.cwd}/.agent-hooks/state`);
  await fs.write(hashPath, `${hash}\n`);
}
