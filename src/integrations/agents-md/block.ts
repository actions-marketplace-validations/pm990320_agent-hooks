/**
 * agent-hooks injects a small block of instructions into `CLAUDE.md`
 * and/or `AGENTS.md` so coding agents reading those files learn to use
 * `agent-hooks ci`, `agent-hooks run <pipeline>`, `agent-hooks fix
 * <step>`, skip directives, etc. — instead of firing bare linters and
 * test runners and ignoring the user's configured pipelines.
 *
 * The block body is **deliberately constant**: the same bytes for
 * every project. Agents treat CLAUDE.md / AGENTS.md as prompt
 * context, and constant content across projects means that context
 * hits the model's prompt cache every time. Project-specific details
 * (pipeline names, fix-capable steps, etc.) are discoverable via
 * `agent-hooks list`, which the block itself points at.
 *
 * The block is delimited by HTML comment markers so hand-edits
 * elsewhere in the file are never touched:
 *
 *     <!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:<sha8> -->
 *     ...constant content...
 *     <!-- END AGENT-HOOKS INTEGRATION -->
 *
 * Re-runs of init compute the hash of the fresh content; when it
 * matches the hash in the existing block we noop, when it doesn't we
 * splice the new content into the *exact* byte range the markers
 * enclose. Content outside the markers is byte-for-byte preserved.
 *
 * This module is pure: no fs, no process env, no side effects.
 */

import { createHash } from "node:crypto";

export const BLOCK_VERSION = 1;
const BEGIN_PREFIX = "<!-- BEGIN AGENT-HOOKS INTEGRATION";
const END_MARKER = "<!-- END AGENT-HOOKS INTEGRATION -->";

// --- Block body (constant) ---------------------------------------------

/**
 * The canonical block body. Identical for every project so prompt
 * caching works across repos. Run `agent-hooks list` to get the
 * project-specific details (pipeline names, step list, which steps
 * have a `fix:` command).
 */
export const BLOCK_BODY = [
  "## agent-hooks",
  "",
  "This project uses [agent-hooks](https://github.com/pm990320/agent-hooks)",
  "as the canonical entry point for CI, linting, tests, and other dev-loop",
  "commands. **Prefer the commands below over bare tool invocations** —",
  "they honor the project's configured pipelines, file scopes, and skip",
  "rules.",
  "",
  "### Core commands",
  "",
  "- `agent-hooks ci` — run the full CI pipeline locally (exactly what GitHub Actions runs)",
  "- `agent-hooks run <pipeline-or-step>` — run a specific pipeline or step",
  "- `agent-hooks lint` / `test` / `build` / `typecheck` / `format` — shortcuts for the same-named pipelines",
  "- `agent-hooks fix <step>` — run a step's auto-fix command (e.g. `agent-hooks fix lint`)",
  "- `agent-hooks list` — list every configured step and pipeline for this project",
  "- `agent-hooks doctor` — validate config, preflight, and environment",
  "",
  "Run `agent-hooks list` first to discover what pipelines and steps this",
  "project defines. Run `agent-hooks --help` for the full CLI.",
  "",
  "### Scope flags",
  "",
  "Shared by `run` / `ci` / shortcuts:",
  "",
  "- `--files <paths…>` — explicit files (what agent hooks pass through)",
  "- `--staged` — files staged for commit",
  "- `--changed` — files changed vs the default branch merge-base",
  "- `--all` — every tracked file",
  "",
  "### Skipping hooks",
  "",
  "When you legitimately need to bypass the pipeline for a commit:",
  "",
  "- Commit message tag: `[skip agent-hooks]` or `[skip ci]` — skips everything for that commit",
  "- Commit message scoped: `[skip lint,test]` — skips specific steps by name",
  "- Env var: `AGENT_HOOKS_SKIP=1` (skip all) or `AGENT_HOOKS_SKIP=lint,test` (by name)",
  "- Env var: `AGENT_HOOKS_ONLY=lint` to whitelist a single step",
  "- CLI flags: `--skip <names>` / `--only <names>` on `run` / `ci`",
  "",
  "Don't skip just to make a red build green — fix the underlying issue.",
  "",
  "### Piping output",
  "",
  "Each step emits an `---agent-hooks:next-step---` YAML block to stderr",
  "with structured feedback (status, exit code, next action). Pass",
  "`--no-prompts` to suppress these blocks when the caller doesn't need",
  "them.",
].join("\n");

/**
 * Return the constant block body. Kept as a function (rather than
 * just exporting `BLOCK_BODY`) so external callers can treat this as
 * an API point that might later accept parameters — today it
 * deliberately ignores any input.
 */
export function renderBlockBody(): string {
  return BLOCK_BODY;
}

// --- Hash ---------------------------------------------------------------

/**
 * Compute a short SHA-256 of the rendered block body. Used to detect
 * drift — if a re-run produces a matching hash we skip the write.
 * Since the body is a constant today, this hash is effectively a
 * version marker that only changes when we update agent-hooks.
 */
export function computeBlockHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

// --- Marker handling ----------------------------------------------------

/**
 * Produce the full block including begin/end markers and a trailing
 * newline. The hash is embedded in the begin marker so future runs can
 * compare without re-rendering.
 */
export function wrapBlock(body: string): string {
  const hash = computeBlockHash(body);
  const begin = `${BEGIN_PREFIX} v:${String(BLOCK_VERSION)} hash:${hash} -->`;
  return `${begin}\n${body}\n${END_MARKER}`;
}

export interface FoundBlock {
  /** Byte offset of the first character of the BEGIN marker line. */
  readonly start: number;
  /** Byte offset just past the END marker line (not including trailing newline). */
  readonly end: number;
  /** Hash extracted from the BEGIN marker. */
  readonly hash: string;
}

/**
 * Locate an existing block in `text`. Returns null when the file has
 * no marker. Tolerates surrounding whitespace but requires both
 * markers on their own lines so we never accidentally match a BEGIN
 * inside a code fence as a real block.
 */
export function findBlock(text: string): FoundBlock | null {
  const beginRegex = new RegExp(
    `^${escapeRegex(BEGIN_PREFIX)} v:(\\d+) hash:([a-f0-9]+) -->$`,
    "m",
  );
  const beginMatch = beginRegex.exec(text);
  if (!beginMatch) return null;
  const start = beginMatch.index;
  const afterBegin = start + beginMatch[0].length;
  const endRegex = new RegExp(`^${escapeRegex(END_MARKER)}$`, "m");
  endRegex.lastIndex = afterBegin;
  const endMatch = endRegex.exec(text.slice(afterBegin));
  if (!endMatch) return null;
  const absoluteEndStart = afterBegin + endMatch.index;
  const end = absoluteEndStart + endMatch[0].length;
  return {
    start,
    end,
    hash: beginMatch[2]!,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Splice --------------------------------------------------------------

export type SpliceAction = "inserted" | "refreshed" | "unchanged" | "removed";

export interface SpliceResult {
  readonly text: string;
  readonly action: SpliceAction;
}

/**
 * Inject `body` into `text`, wrapped in markers. Rules:
 *
 *   - No existing block: append the full block to the end of `text`,
 *     separated by a blank line. Preserves every byte of `text` before
 *     the appended region.
 *   - Existing block with matching hash: return `text` unchanged.
 *   - Existing block with stale hash: replace exactly the marker-to-
 *     marker byte range with the new block. Everything outside that
 *     range is preserved byte-for-byte.
 */
export function spliceBlock(text: string, body: string): SpliceResult {
  const wrapped = wrapBlock(body);
  const existing = findBlock(text);
  if (!existing) {
    // Append with a clear separator. Normalize trailing newlines on
    // the incoming text so the seam between the user's content and
    // ours is exactly one blank line.
    const trimmed = text.replace(/\s+$/, "");
    const separator = trimmed.length === 0 ? "" : "\n\n";
    return {
      text: `${trimmed}${separator}${wrapped}\n`,
      action: "inserted",
    };
  }
  const currentHash = computeBlockHash(body);
  if (existing.hash === currentHash) {
    return { text, action: "unchanged" };
  }
  const before = text.slice(0, existing.start);
  const after = text.slice(existing.end);
  return {
    text: `${before}${wrapped}${after}`,
    action: "refreshed",
  };
}

/**
 * Remove an existing block. Returns `{ action: "unchanged" }` when no
 * block was present. Strips at most one trailing newline that separated
 * the block from preceding content so we don't leave a ragged edge.
 */
export function removeBlock(text: string): SpliceResult {
  const existing = findBlock(text);
  if (!existing) return { text, action: "unchanged" };
  let start = existing.start;
  let end = existing.end;
  // Swallow a single trailing newline after the end marker so we
  // don't leave stray whitespace above whatever followed the block.
  if (text[end] === "\n") end += 1;
  // Trim a preceding blank-line gap (the one we inserted on insert).
  if (start >= 2 && text.slice(start - 2, start) === "\n\n") {
    start -= 1;
  }
  return {
    text: `${text.slice(0, start)}${text.slice(end)}`,
    action: "removed",
  };
}
