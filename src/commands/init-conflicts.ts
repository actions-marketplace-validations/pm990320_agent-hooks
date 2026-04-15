/**
 * Init conflict handling (PLAN §4.3). When `agent-hooks init` would
 * overwrite an existing file, we surface a unified diff and ask the
 * user what to do: [k]eep, [o]verwrite, [m]erge, [s]kip.
 *
 * This module is pure-ish — it owns the diff, the prompt contract, and
 * the safe-merge logic. I/O (reading stdin, writing stdout) lives
 * behind the `ConflictPrompter` interface so tests can inject answers.
 */

import YAML from "yaml";

export type ConflictChoice = "keep" | "overwrite" | "merge" | "skip";

export interface ConflictPromptInput {
  /** Absolute path being considered. */
  readonly path: string;
  /** Unified diff as a single pre-formatted string. */
  readonly diff: string;
  /** True when semantic merge would succeed for this pair. */
  readonly canMerge: boolean;
}

export interface ConflictPrompter {
  prompt(input: ConflictPromptInput): Promise<ConflictChoice>;
}

// --- Line diff ----------------------------------------------------------

export type DiffOpKind = "equal" | "add" | "remove";

export interface DiffLine {
  readonly kind: DiffOpKind;
  readonly text: string;
}

/**
 * Produce a line-level diff of `oldText` vs `newText` using a simple
 * Longest Common Subsequence reconstruction. Good enough for short
 * config files; we're not diffing 10k-line monsters here.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const m = a.length;
  const n = b.length;
  // lcs[i][j] = length of LCS of a[0..i) and b[0..j).
  const lcs: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      const row = lcs[i + 1]!;
      const prevRow = lcs[i]!;
      if (a[i] === b[j]) {
        row[j + 1] = (prevRow[j] ?? 0) + 1;
      } else {
        row[j + 1] = Math.max(prevRow[j + 1] ?? 0, row[j] ?? 0);
      }
    }
  }
  const out: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: "equal", text: a[i - 1]! });
      i--;
      j--;
    } else if ((lcs[i - 1]?.[j] ?? 0) >= (lcs[i]?.[j - 1] ?? 0)) {
      out.push({ kind: "remove", text: a[i - 1]! });
      i--;
    } else {
      out.push({ kind: "add", text: b[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: "remove", text: a[--i]! });
  }
  while (j > 0) {
    out.push({ kind: "add", text: b[--j]! });
  }
  return out.reverse();
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  // Drop the trailing empty slice produced by a final newline so a file
  // ending in "\n" doesn't diff as "extra empty line".
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Render a diff as a compact unified-style text with `+`/`-`/` ` prefix
 * markers. No hunk headers — init diffs are short enough that a flat
 * listing is more readable than git's @@ hunks.
 */
export function formatDiff(diff: readonly DiffLine[]): string {
  const lines = diff.map((line) => {
    const prefix =
      line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  ";
    return `${prefix}${line.text}`;
  });
  return lines.join("\n");
}

/** True when the two texts differ after ignoring trailing newlines. */
export function textsDiffer(oldText: string, newText: string): boolean {
  return oldText.replace(/\n+$/, "") !== newText.replace(/\n+$/, "");
}

// --- YAML merge ---------------------------------------------------------

/**
 * Conservative additive merge of two YAML documents: existing keys keep
 * their current values, new keys from `newText` are added. For `steps:`
 * and `pipelines:` we merge the sub-maps; for `git.hooks:` we do the
 * same. Everything else: existing value wins.
 *
 * Returns the merged YAML source (with the old document's comments and
 * ordering preserved via `yaml`'s Document API) on success, or `null`
 * when the merge would be unsafe — either input fails to parse, or the
 * top level isn't a plain object.
 */
export function mergeYamlConfigs(
  oldText: string,
  newText: string,
): string | null {
  let oldDoc;
  let newDoc;
  try {
    oldDoc = YAML.parseDocument(oldText);
    newDoc = YAML.parseDocument(newText);
  } catch {
    return null;
  }
  if (oldDoc.errors.length > 0 || newDoc.errors.length > 0) return null;
  if (!YAML.isMap(oldDoc.contents) || !YAML.isMap(newDoc.contents)) {
    return null;
  }

  const oldMap = oldDoc.contents;
  const newMap = newDoc.contents;

  for (const pair of newMap.items) {
    const key = scalarKeyToString(pair.key);
    if (key === null) continue;
    if (!oldMap.has(key)) {
      oldDoc.set(key, pair.value);
      continue;
    }
    // Sub-map merges: steps / pipelines / env. Same "add if missing,
    // don't touch if present" semantic.
    if (isMergeableSubmap(key)) {
      mergeSubmap(oldMap, newMap, key);
    }
  }

  return oldDoc.toString();
}

function isMergeableSubmap(key: string): boolean {
  return key === "steps" || key === "pipelines" || key === "env";
}

function mergeSubmap(
  oldMap: YAML.YAMLMap,
  newMap: YAML.YAMLMap,
  key: string,
): void {
  const oldSub = oldMap.get(key, true);
  const newSub = newMap.get(key, true);
  if (!YAML.isMap(oldSub) || !YAML.isMap(newSub)) return;
  for (const pair of newSub.items) {
    const subKey = scalarKeyToString(pair.key);
    if (subKey === null) continue;
    if (!oldSub.has(subKey)) {
      oldSub.set(pair.key, pair.value);
    }
  }
}

/**
 * Coerce a YAML AST key to a plain string. Accepts the string-scalar
 * and plain-string cases; returns null for anything that isn't a
 * scalar (YAML technically permits complex keys — we don't touch those).
 */
function scalarKeyToString(key: unknown): string | null {
  if (typeof key === "string") return key;
  if (YAML.isScalar(key)) {
    const raw = key.value;
    if (typeof raw === "string") return raw;
    if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  }
  return null;
}

/**
 * Decide whether a given path supports semantic merge. We only offer
 * merge for `agent-hooks.yml` style YAML; workflow files and any other
 * path fall back to keep/overwrite/skip.
 */
export function canSemanticMerge(path: string): boolean {
  return /agent-hooks\.ya?ml$/i.test(path);
}

// --- Default prompter ---------------------------------------------------

/**
 * Non-interactive default prompter — used as the fallback on non-TTY
 * environments. Always answers "keep" so init can't accidentally nuke
 * user files when piped into a non-interactive shell.
 */
export const nonInteractiveKeepPrompter: ConflictPrompter = {
  prompt: () => Promise.resolve("keep"),
};

/**
 * Build an interactive prompter over a caller-supplied reader/writer.
 * Split out from the defaultConflictPrompter so tests can feed a
 * fake reader without touching process.stdin.
 */
export function createInteractivePrompter(opts: {
  readonly read: (prompt: string) => Promise<string>;
  readonly write: (text: string) => void;
}): ConflictPrompter {
  return {
    async prompt(input) {
      opts.write(`\nconflict: ${input.path}\n`);
      opts.write(`${input.diff}\n`);
      const options = input.canMerge
        ? "[k]eep / [o]verwrite / [m]erge / [s]kip"
        : "[k]eep / [o]verwrite / [s]kip";
      for (;;) {
        const raw = await opts.read(`${options} (k): `);
        const answer = raw.trim().toLowerCase();
        if (answer === "" || answer === "k" || answer === "keep") return "keep";
        if (answer === "o" || answer === "overwrite") return "overwrite";
        if (answer === "s" || answer === "skip") return "skip";
        if ((answer === "m" || answer === "merge") && input.canMerge) {
          return "merge";
        }
        opts.write(`  unrecognized answer "${raw.trim()}" — try again.\n`);
      }
    },
  };
}
