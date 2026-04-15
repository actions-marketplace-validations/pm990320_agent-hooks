import { join, relative, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

export const DEFAULT_ARTIFACT_PATHS = [
  "test-results",
  "coverage",
  "report",
  "dist",
  "build",
  ".next",
  "target",
  "test-results/checkpoints",
  "playwright-report",
] as const;

export interface ArtifactRecord {
  readonly mtimeMs: number;
  readonly size: number;
}

export type ArtifactSnapshot = ReadonlyMap<string, ArtifactRecord>;

/**
 * Merge default locations with step-defined artifacts, while
 * deduplicating and preserving order.
 */
export function effectiveArtifactInputs(
  stepArtifacts?: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of [...DEFAULT_ARTIFACT_PATHS, ...(stepArtifacts ?? [])]) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizePath(cwd: string, fullPath: string): string {
  return relative(cwd, fullPath);
}

/**
 * Snapshot existing artifacts as a map of `path -> {size,mtimeMs}`.
 *
 * Paths that do not exist are ignored.
 */
export function snapshotArtifacts(
  cwd: string,
  candidates: readonly string[],
): ArtifactSnapshot {
  const entries = new Map<string, ArtifactRecord>();
  for (const candidate of candidates) {
    const full = resolve(cwd, candidate);
    collectArtifacts(full, cwd, entries);
  }
  return entries;
}

function collectArtifacts(
  fullPath: string,
  cwd: string,
  entries: Map<string, ArtifactRecord>,
): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(fullPath);
  } catch {
    return;
  }

  if (!stats.isDirectory()) {
    if (stats.isFile()) {
      entries.set(normalizePath(cwd, fullPath), {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    }
    return;
  }

  // Directory snapshot: record files recursively.
  for (const entry of readdirSync(fullPath, { withFileTypes: true })) {
    const next = join(fullPath, entry.name);
    if (entry.isDirectory()) {
      collectArtifacts(next, cwd, entries);
    } else if (entry.isSymbolicLink()) {
      continue;
    } else if (entry.isFile()) {
      const statValue = statSync(next);
      if (statValue.isFile()) {
        entries.set(normalizePath(cwd, next), {
          mtimeMs: statValue.mtimeMs,
          size: statValue.size,
        });
      }
    } else if (entry.isBlockDevice()) {
      // no-op
    } else if (entry.isCharacterDevice()) {
      // no-op
    } else if (entry.isFIFO()) {
      // no-op
    }
  }
}

/**
 * Return only newly created / changed artifact files between snapshots.
 */
export function diffArtifacts(
  before: ArtifactSnapshot,
  after: ArtifactSnapshot,
): string[] {
  const changed: string[] = [];
  for (const [path, afterMeta] of after) {
    const beforeMeta = before.get(path);
    if (!beforeMeta) {
      changed.push(path);
      continue;
    }
    if (
      beforeMeta.size !== afterMeta.size ||
      beforeMeta.mtimeMs !== afterMeta.mtimeMs
    ) {
      changed.push(path);
    }
  }
  changed.sort();
  return changed;
}
