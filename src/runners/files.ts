import nodePath from "node:path";
import picomatch from "picomatch";
import { registerChild } from "./process-registry.ts";

/**
 * Scope kinds supported by every file-consuming command.
 *
 *   - explicit: caller supplied an explicit file list (agent hooks, git hooks)
 *   - staged: staged changes (`git diff --cached --name-only`)
 *   - changed: diff vs the merge-base of the default branch
 *   - all: every file the repo considers part of the project — tracked
 *     plus untracked-but-not-ignored (`git ls-files -co --exclude-standard`)
 */
export type Scope = "explicit" | "staged" | "changed" | "all";

export interface GitRunner {
  /** Lines from `git diff --cached --name-only --diff-filter=ACMRT` (staged, non-deleted). */
  staged(): Promise<readonly string[]>;
  /** Lines from `git diff --name-only --diff-filter=ACMRT <merge-base>...HEAD`. */
  changed(baseRef?: string): Promise<readonly string[]>;
  /**
   * Lines from `git ls-files --cached --others --exclude-standard` —
   * tracked files plus untracked files that aren't gitignored. This
   * matches what a developer thinks of as "every file in the repo",
   * not just what's committed.
   */
  all(): Promise<readonly string[]>;
  /**
   * Absolute path of the git working tree root (`git rev-parse
   * --show-toplevel`), or `null` if the cwd isn't inside a git repo.
   * Callers use this to re-anchor at the repo root so commands run
   * from a subdir don't see a partial file list.
   */
  gitRoot?(): Promise<string | null>;
  /**
   * The full message of HEAD's commit, or `null` if the repo is empty,
   * the cwd isn't a git repo, or git is otherwise unavailable. Used by
   * the run command to honor `[skip ci]` / `[skip agent-hooks]` tags
   * that developers add to their commit messages. Best-effort: failures
   * never bubble up because this is purely advisory.
   */
  commitMessage?(): Promise<string | null>;
  /**
   * List working-tree changes (modified-tracked + untracked non-ignored)
   * under `subPath` (relative to the repo root). Empty when nothing's
   * changed. Used by the pre-commit beads auto-stager to find
   * `.beads/*` edits that should be folded into the in-progress commit.
   */
  modifiedUnder?(subPath: string): Promise<readonly string[]>;
  /**
   * Stage the given files with `git add --`. Invoked by the auto-stager
   * in a single batch so a huge .beads/ change still amounts to one
   * git call on the pre-commit hot path.
   */
  stage?(paths: readonly string[]): Promise<void>;
}

export interface ResolveOptions {
  readonly scope: Scope;
  /** Files supplied via `--files`. Required for scope = "explicit". */
  readonly files?: readonly string[];
  /** Base branch for `changed`. Defaults to "origin/main". */
  readonly baseRef?: string;
  /**
   * Repo root used to clamp explicit file paths. Any path outside
   * this root is rejected by `resolveFiles` unless
   * `allowOutsideRepo` is set. Required for the explicit scope when
   * the boundary check is enabled.
   */
  readonly repoRoot?: string;
  /**
   * Skip the path-boundary check on explicit-scope file lists. Use
   * sparingly — paths outside the repo are usually a footgun (or an
   * agent injecting paths it shouldn't). Default: false.
   */
  readonly allowOutsideRepo?: boolean;
}

/** Thrown when an explicit file path escapes the repo root. */
export class PathOutsideRepoError extends Error {
  readonly path: string;
  constructor(path: string, repoRoot: string) {
    super(
      `path "${path}" is outside the repo root (${repoRoot}). ` +
        `Use --allow-outside-repo to override.`,
    );
    this.name = "PathOutsideRepoError";
    this.path = path;
  }
}

export interface ResolvedFiles {
  readonly scope: Scope;
  readonly files: readonly string[];
}

/**
 * Produce the raw file list for a given scope, without any step-level glob
 * filter applied. Step-level filtering happens via `filterByGlob` once a
 * specific step is selected — different steps may care about different
 * subsets of the same base list.
 */
export async function resolveFiles(
  git: GitRunner,
  options: ResolveOptions,
): Promise<ResolvedFiles> {
  switch (options.scope) {
    case "explicit": {
      const raw = dedupe(options.files ?? []);
      if (options.allowOutsideRepo || options.repoRoot === undefined) {
        return { scope: "explicit", files: raw };
      }
      // Clamp to the repo root: any path that resolves outside is a
      // hard error. Catches accidental `--files /etc/passwd` and
      // hostile paths injected by an upstream agent.
      const root = nodePath.resolve(options.repoRoot);
      const checked = raw.map((p) => {
        const absolute = nodePath.isAbsolute(p)
          ? nodePath.resolve(p)
          : nodePath.resolve(root, p);
        const rel = nodePath.relative(root, absolute);
        if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
          throw new PathOutsideRepoError(p, root);
        }
        return p;
      });
      return { scope: "explicit", files: checked };
    }
    case "staged":
      return { scope: "staged", files: dedupe(await git.staged()) };
    case "changed":
      return {
        scope: "changed",
        files: dedupe(await git.changed(options.baseRef)),
      };
    case "all":
      return { scope: "all", files: dedupe(await git.all()) };
  }
}

/**
 * Filter a raw list through a step's `files:` glob. Uses picomatch
 * so users get a widely-understood glob dialect.
 *
 * An empty or undefined glob is treated as "no filter".
 *
 * Case sensitivity: defaults to platform sensible — case-insensitive
 * on darwin (default APFS is case-insensitive) and win32, case-
 * sensitive on linux. Override with the `nocase` option.
 */
export function filterByGlob(
  files: readonly string[],
  glob: string | undefined,
  options: { nocase?: boolean } = {},
): readonly string[] {
  if (!glob) return files;
  const nocase = options.nocase ?? defaultNocase();
  const isMatch = picomatch(glob, { dot: true, nocase });
  return files.filter((f) => isMatch(f));
}

/**
 * Pick the right case-sensitivity default for the current platform.
 * macOS HFS+/APFS and Windows are case-insensitive by default; Linux
 * filesystems are case-sensitive. Linux users with a case-insensitive
 * mount can opt in via the `nocase` argument or a future config field.
 */
function defaultNocase(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function dedupe(files: readonly string[]): readonly string[] {
  return [...new Set(files.filter((f) => f.length > 0))];
}

// --- Default git runner (process-exec-based) -----------------------------

/**
 * Minimal child-process spawner type. Injectable so the default GitRunner's
 * exec path can be tested without shelling out.
 *
 * Captures both streams plus a signal name so error wrapping can
 * distinguish "git printed an error and exited 128" from "the kernel
 * killed git with SIGKILL". Bun coerces signal-terminated exits to
 * 128+N and exposes `proc.signalCode` for the human-readable name.
 */
export type Spawner = (
  command: readonly string[],
  cwd: string,
) => Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly signal?: string | null;
}>;

/**
 * Translate a raw spawn failure into a typed error. Pure so it can be
 * unit-tested without standing up a Bun subprocess. Currently catches
 * one case: ENOENT for `git`, surfaced as `GitNotInstalledError`.
 */
export function wrapSpawnError(
  err: unknown,
  command: readonly string[],
): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" && command[0] === "git") {
    return new GitNotInstalledError();
  }
  return err as Error;
}

export const defaultSpawner: Spawner = async (command, cwd) => {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: [...command],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw wrapSpawnError(err, command);
  }
  const dispose = registerChild(proc);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, signal: proc.signalCode };
  } finally {
    dispose();
  }
};

/** Thrown when git isn't on PATH. */
export class GitNotInstalledError extends Error {
  constructor() {
    super(
      "git is not installed or not on PATH. " +
        "Install git (https://git-scm.com/downloads) and try again.",
    );
    this.name = "GitNotInstalledError";
  }
}

/** Thrown when the cwd isn't a git repository. */
export class NotAGitRepositoryError extends Error {
  constructor(cwd: string) {
    super(`not a git repository: ${cwd}`);
    this.name = "NotAGitRepositoryError";
  }
}

/** Thrown when the requested base ref can't be resolved. */
export class UnresolvableBaseRefError extends Error {
  constructor(baseRef: string, attempted: readonly string[]) {
    super(
      `cannot resolve base ref "${baseRef}" for --changed (tried: ${attempted.join(", ")}). ` +
        `Pass --base <ref> or set up a tracking branch.`,
    );
    this.name = "UnresolvableBaseRefError";
  }
}

const NOT_A_REPO_NEEDLE = "not a git repository";

/**
 * Global git args threaded onto every invocation:
 *
 *   -c core.quotePath=false  → emit non-ASCII filenames raw, not as
 *     C-style escapes like "caf\303\251.txt". Belt-and-braces for the
 *     non -z calls; -z output already ignores quotePath.
 */
const GIT_GLOBAL_ARGS = ["-c", "core.quotePath=false"];

export function createGitRunner(
  cwd: string,
  spawner: Spawner = defaultSpawner,
): GitRunner {
  function failed(args: readonly string[], result: {
    readonly stderr: string;
    readonly exitCode: number;
    readonly signal?: string | null;
  }): never {
    if (result.stderr.toLowerCase().includes(NOT_A_REPO_NEEDLE)) {
      throw new NotAGitRepositoryError(cwd);
    }
    const detail = result.stderr.trim();
    const tail = detail.length > 0 ? `: ${detail}` : "";
    if (result.signal) {
      throw new Error(
        `git ${args.join(" ")} was killed by ${result.signal}${tail}`,
      );
    }
    throw new Error(
      `git ${args.join(" ")} exited with code ${String(result.exitCode)}${tail}`,
    );
  }

  async function spawnGit(
    args: readonly string[],
  ): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
    readonly signal?: string | null;
  }> {
    return spawner(["git", ...GIT_GLOBAL_ARGS, ...args], cwd);
  }

  /** Newline-delimited stdout. Use only for output that's guaranteed
   * ASCII / single-line (refs, SHAs, exit codes). For filename lists
   * use `runZ()` instead. */
  async function run(args: readonly string[]): Promise<readonly string[]> {
    const result = await spawnGit(args);
    if (result.exitCode !== 0 || result.signal) failed(args, result);
    return result.stdout.split("\n").filter((line) => line.length > 0);
  }

  /** NUL-delimited stdout. Use for any command that emits filenames
   * (ls-files, diff --name-only). Survives newlines and special chars
   * in path names. Caller must pass `-z` in `args`. */
  async function runZ(args: readonly string[]): Promise<readonly string[]> {
    const result = await spawnGit(args);
    if (result.exitCode !== 0 || result.signal) failed(args, result);
    return result.stdout.split("\0").filter((line) => line.length > 0);
  }

  /**
   * Try to resolve `ref` to a commit. Returns the SHA on success, or
   * `null` if the ref doesn't exist (rather than throwing). Other
   * failures (not-a-repo, missing git, signal) still throw.
   */
  async function tryRevParse(ref: string): Promise<string | null> {
    const result = await spawnGit([
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (result.exitCode === 0 && !result.signal) {
      return result.stdout.trim() || null;
    }
    // Not-a-repo / signals still need to surface — only swallow the
    // "unknown ref" case (rev-parse --quiet exits 1 with empty stderr).
    if (result.stderr.toLowerCase().includes(NOT_A_REPO_NEEDLE)) {
      throw new NotAGitRepositoryError(cwd);
    }
    if (result.signal) failed(["rev-parse", ref], result);
    return null;
  }

  return {
    staged() {
      return runZ([
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMRT",
        "-z",
      ]);
    },
    async changed(baseRef = "origin/main") {
      // Resolve a usable base. Try the configured ref first, then fall
      // back through the common local branch names so a fresh repo with
      // no remote (no `origin/main`) Just Works against local `main` or
      // `master`. An empty list means "diff against itself" — no churn.
      const candidates =
        baseRef === "origin/main" ? [baseRef, "main", "master"] : [baseRef];
      const tried: string[] = [];
      let resolvedBase: string | null = null;
      for (const candidate of candidates) {
        tried.push(candidate);
        const sha = await tryRevParse(candidate);
        if (sha) {
          resolvedBase = sha;
          break;
        }
      }
      if (!resolvedBase) {
        throw new UnresolvableBaseRefError(baseRef, tried);
      }
      // Use merge-base to scope the diff to the divergence point so a
      // long-lived branch doesn't surface its whole history as changed.
      const mergeBases = await run(["merge-base", resolvedBase, "HEAD"]);
      const base = mergeBases[0] ?? resolvedBase;
      return runZ([
        "diff",
        "--name-only",
        "--diff-filter=ACMRT",
        "-z",
        `${base}...HEAD`,
      ]);
    },
    all() {
      return runZ([
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ]);
    },
    async commitMessage() {
      // Best-effort: an empty repo (no HEAD), a non-git cwd, or a
      // missing git binary all yield `null` rather than propagating.
      // The caller treats this as advisory input only.
      try {
        const result = await spawnGit(["log", "-1", "--format=%B"]);
        if (result.exitCode !== 0 || result.signal) return null;
        return result.stdout.replace(/\n+$/, "");
      } catch {
        return null;
      }
    },
    async gitRoot() {
      try {
        const lines = await run(["rev-parse", "--show-toplevel"]);
        const first = lines[0]?.trim();
        return first && first.length > 0 ? first : null;
      } catch {
        return null;
      }
    },
    async modifiedUnder(subPath) {
      // `status --porcelain=v1 -z` gives us modified-tracked + untracked
      // in a single pass. The -- separator scopes the query to subPath
      // so we don't pay for a full status on big repos. Format per
      // git-status(1): XY<space>path<NUL>, possibly with a rename
      // "path1<NUL>path2" pair — we take the second path in that case.
      const result = await spawnGit([
        "status",
        "--porcelain=v1",
        "-z",
        "--",
        subPath,
      ]);
      if (result.exitCode !== 0 || result.signal) return [];
      const entries: string[] = [];
      const raw = result.stdout;
      let i = 0;
      while (i < raw.length) {
        const nul = raw.indexOf("\0", i);
        if (nul < 0) break;
        // The first three chars are "XY " — skip them to land on the path.
        const entry = raw.slice(i, nul);
        if (entry.length < 3) {
          i = nul + 1;
          continue;
        }
        const status = entry.slice(0, 2);
        const pathPart = entry.slice(3);
        i = nul + 1;
        // Rename entries carry a second NUL-delimited "from" path —
        // consume it so we don't mis-read it as a new entry on the
        // next iteration.
        if (status.startsWith("R") || status.startsWith("C")) {
          const fromNul = raw.indexOf("\0", i);
          if (fromNul >= 0) i = fromNul + 1;
        }
        entries.push(pathPart);
      }
      return entries;
    },
    async stage(paths) {
      if (paths.length === 0) return;
      const result = await spawnGit(["add", "--", ...paths]);
      if (result.exitCode !== 0 || result.signal) {
        failed(["add", ...paths], result);
      }
    },
  };
}
