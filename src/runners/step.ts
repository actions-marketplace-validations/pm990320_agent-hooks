import { access } from "node:fs/promises";
import path from "node:path";
import type { Step } from "../config/schema.ts";
import { resolveAreas, type AreaDecision } from "./areas.ts";

// --- Public API ----------------------------------------------------------

export type StepStatus = "passed" | "failed" | "warned" | "skipped";

export interface StepInvocation {
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut?: boolean;
}

export interface StepResult {
  readonly status: StepStatus;
  readonly exitCode: number;
  readonly invocations: readonly StepInvocation[];
  /** Set when status is "skipped" to explain why. */
  readonly reason?: string;
  readonly durationMs: number;
  /** Effective file list used for this step run. */
  readonly files?: readonly string[];
  /** Set when an area map rewrote the step's file list. */
  readonly area?: AreaDecision;
}

export interface StepRunOptions {
  readonly name: string;
  readonly step: Step;
  /** Files already filtered through the step's `files:` glob. */
  readonly files: readonly string[];
  /** True when the caller forces a project-scope run (e.g. `--all`). */
  readonly projectForced?: boolean;
  readonly cwd: string;
  readonly repoRoot?: string;
  readonly env?: Record<string, string>;
  /** How child stdio reaches the parent. See ExecOutputMode. */
  readonly output?: ExecOutputMode;
}

export type ExecFn = (input: ExecInput) => Promise<ExecResult>;

/**
 * How a step's stdout/stderr should reach the parent.
 *
 * - `inherit`: child stdio is wired straight to the parent's terminal.
 *   Output streams live, but two children writing concurrently would
 *   interleave on the same FD. Use for sequential pipelines.
 * - `buffered`: child stdio is piped, captured in memory, and flushed
 *   to the parent atomically on step end. Lossy for very long streams
 *   (memory-bounded), but ordering is sane in parallel pipelines. Use
 *   for parallel pipelines.
 */
export type ExecOutputMode = "inherit" | "buffered" | "buffered-on-failure";

export interface ExecInput {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  /** Defaults to `inherit` (callers should pick explicitly). */
  readonly output?: ExecOutputMode;
  /**
   * Hard timeout in milliseconds. 0 or undefined = no timeout. When
   * the deadline expires the spawner sends SIGTERM, waits briefly,
   * then SIGKILL, and returns `{ exitCode: 124, timedOut: true }`.
   * Exit code 124 matches GNU `timeout`'s convention.
   */
  readonly timeoutMs?: number;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly durationMs: number;
  /** Set by the spawner when the step exceeded its `timeoutMs`. */
  readonly timedOut?: boolean;
}

// --- Template variables --------------------------------------------------

/**
 * Shell-quote a single path with POSIX single-quote rules. Safe for any
 * filename including ones with spaces, quotes, and glob metacharacters.
 */
export function shellQuote(path: string): string {
  // Wrap in single quotes and escape any existing single quotes by ending
  // the quoted section, appending an escaped quote, and reopening.
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/** Space-join a list of paths with each one shell-quoted. */
export function joinFiles(files: readonly string[]): string {
  return files.map(shellQuote).join(" ");
}

/** Newline-join paths, quoted. */
export function joinFilesNewline(files: readonly string[]): string {
  return files.map(shellQuote).join("\n");
}

/**
 * Build a brace expansion for `glob` mode. Single file → plain path,
 * multiple files → `{a,b,c}`. Paths are shell-quoted because they sit
 * inside a shell command.
 */
export function joinFilesBrace(files: readonly string[]): string {
  const [first, ...rest] = files;
  if (first === undefined) return "";
  if (rest.length === 0) return shellQuote(first);
  return `{${files.map(shellQuote).join(",")}}`;
}

export interface TemplateContext {
  readonly cwd: string;
  readonly repoRoot: string;
  readonly env: Record<string, string>;
  readonly files: readonly string[];
  readonly file?: string;
  readonly dir?: string;
}

/**
 * Substitute `{files}`, `{file}`, `{files_newline}`, `{glob}`, `{cwd}`,
 * `{env.NAME}` tokens in a command template. Unrecognized `{…}` tokens
 * are left untouched so shell brace expansions (e.g. `{a,b,c}`) still
 * pass through to the shell.
 *
 * The outer regex matches any `{word}`-shaped token; the callback decides
 * whether to substitute. Anything with commas, spaces, or other shell
 * metacharacters doesn't match the regex and is left alone by replace().
 */
export function applyTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(
    /\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g,
    (match, key: string) => {
      if (key === "files") return joinFiles(ctx.files);
      if (key === "file") return ctx.file ? shellQuote(ctx.file) : "";
      if (key === "dir") return ctx.dir ? shellQuote(ctx.dir) : "";
      if (key === "files_newline") return joinFilesNewline(ctx.files);
      if (key === "glob") return joinFilesBrace(ctx.files);
      if (key === "cwd") return shellQuote(ctx.cwd);
      if (
        key === "repo-root" ||
        key === "repo_root" ||
        key === "git_root"
      ) {
        return shellQuote(ctx.repoRoot);
      }
      if (key.startsWith("env.")) {
        const envName = key.slice(4);
        return ctx.env[envName] ?? "";
      }
      return match;
    },
  );
}

// --- Command resolution --------------------------------------------------

export type Variant = "files" | "project";

/**
 * Pick the right `run:` variant for the given effective mode. Returns the
 * template string, or null if no variant is defined. String-form `run:`
 * serves both modes.
 */
export function pickRunVariant(
  run: Step["run"],
  variant: Variant,
): string | null {
  if (typeof run === "string") return run;
  if (variant === "project") return run.project ?? run.files ?? null;
  return run.files ?? run.project ?? null;
}

// --- Chunking ------------------------------------------------------------

/** Safe default for `sh -c`'s command line — well under any real ARG_MAX. */
export const DEFAULT_CHUNK_BYTES = 100_000;

/**
 * Split `files` into chunks whose combined shell-quoted length stays under
 * `maxBytes` (per chunk). Also obeys an explicit `maxFiles` cap.
 */
export function chunkFiles(
  files: readonly string[],
  maxBytes: number,
  maxFiles?: number,
): readonly (readonly string[])[] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const entryBytes = shellQuote(file).length + 1; // +1 for separating space
    const wouldExceedBytes = currentBytes + entryBytes > maxBytes;
    const wouldExceedCount =
      maxFiles !== undefined && current.length >= maxFiles;
    if (current.length > 0 && (wouldExceedBytes || wouldExceedCount)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += entryBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// --- Main step runner ----------------------------------------------------

function deriveEffectiveMode(
  step: Step,
  projectForced: boolean,
): Step["invocation"] {
  if (projectForced) return "project";
  if (step.scope === "project") return "project";
  return step.invocation;
}

function aggregateExitCode(invocations: readonly StepInvocation[]): number {
  return invocations.reduce((max, inv) => Math.max(max, inv.exitCode), 0);
}

interface InvocationTarget {
  readonly files: readonly string[];
  readonly file?: string;
  readonly dir?: string;
  readonly stdin?: string;
}

async function runSingle(
  command: string,
  options: StepRunOptions,
  exec: ExecFn,
  stdin?: string,
): Promise<StepInvocation> {
  const env = { ...(options.env ?? {}), ...(options.step.env ?? {}) };
  const timeoutMs = options.step["timeout-ms"];
  const result = await exec({
    command,
    cwd: options.cwd,
    env,
    ...(stdin !== undefined ? { stdin } : {}),
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(timeoutMs > 0 ? { timeoutMs } : {}),
  });
  return {
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

function templateCtx(
  options: StepRunOptions,
  files: readonly string[],
  file?: string,
  dir?: string,
): TemplateContext {
  return {
    cwd: options.cwd,
    repoRoot: options.repoRoot ?? options.cwd,
    env: { ...(options.env ?? {}), ...(options.step.env ?? {}) },
    files,
    ...(file !== undefined ? { file } : {}),
    ...(dir !== undefined ? { dir } : {}),
  };
}

function skipped(
  reason: string,
  startedAt: number,
  area?: AreaDecision,
  files?: readonly string[],
): StepResult {
  return {
    status: "skipped",
    exitCode: 0,
    invocations: [],
    reason,
    durationMs: Date.now() - startedAt,
    ...(files ? { files } : {}),
    ...(area ? { area } : {}),
  };
}

function result(
  invocations: readonly StepInvocation[],
  startedAt: number,
  onFailure: "warn" | "fail",
  area?: AreaDecision,
  files?: readonly string[],
): StepResult {
  const exitCode = aggregateExitCode(invocations);
  return {
    status:
      exitCode === 0 ? "passed" : onFailure === "warn" ? "warned" : "failed",
    exitCode,
    invocations,
    durationMs: Date.now() - startedAt,
    ...(files ? { files } : {}),
    ...(area ? { area } : {}),
  };
}

function normalizeList(input: string | readonly string[] | undefined): string[] {
  if (input === undefined) return [];
  if (typeof input === "string") return [input];
  return [...input];
}

function parentDirectory(file: string): string {
  return path.posix.dirname(file);
}

function hasExcludedAncestor(
  candidateDir: string,
  excludedAncestors: readonly string[],
): boolean {
  if (excludedAncestors.length === 0) return false;
  const normalized = candidateDir === "." ? [] : candidateDir.split("/");
  const ancestorSegments = normalized.slice(1, -1);
  return ancestorSegments.some((segment) => excludedAncestors.includes(segment));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findMarkerDirectory(
  cwd: string,
  file: string,
  markers: readonly string[],
  excludedAncestors: readonly string[],
): Promise<string | null> {
  let currentDir = parentDirectory(file);
  for (;;) {
    const foundMarker = await Promise.any(
      markers.map(async (marker) => {
        const markerPath = path.join(cwd, currentDir, marker);
        if (await pathExists(markerPath)) return marker;
        throw new Error("missing marker");
      }),
    ).catch(() => null);
    if (foundMarker !== null) {
      if (!hasExcludedAncestor(currentDir, excludedAncestors)) {
        return currentDir;
      }
    }
    if (currentDir === ".") return null;
    const parentDir = path.posix.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

async function planInvocationTargets(
  runOptions: StepRunOptions,
  mode: Step["invocation"],
): Promise<readonly InvocationTarget[]> {
  if (mode === "per-file") {
    return runOptions.files.map((file) => ({ files: [file], file }));
  }

  if (mode === "per-directory") {
    const groups = new Map<string, string[]>();
    for (const file of runOptions.files) {
      const dir = parentDirectory(file);
      const existing = groups.get(dir);
      if (existing) existing.push(file);
      else groups.set(dir, [file]);
    }
    return [...groups.entries()]
      .sort(([leftDir], [rightDir]) => leftDir.localeCompare(rightDir))
      .map(([dir, files]) => ({ dir, files }));
  }

  if (mode === "per-marker-dir") {
    const groups = new Map<string, string[]>();
    const markers = normalizeList(runOptions.step.marker);
    const excludedAncestors = normalizeList(
      runOptions.step["exclude-ancestors"],
    );
    for (const file of runOptions.files) {
      const dir = await findMarkerDirectory(
        runOptions.cwd,
        file,
        markers,
        excludedAncestors,
      );
      if (!dir) continue;
      const existing = groups.get(dir);
      if (existing) existing.push(file);
      else groups.set(dir, [file]);
    }
    return [...groups.entries()]
      .sort(([leftDir], [rightDir]) => leftDir.localeCompare(rightDir))
      .map(([dir, files]) => ({ dir, files }));
  }

  if (mode === "stdin") {
    return [
      {
        files: runOptions.files,
        stdin: `${runOptions.files.join("\n")}\n`,
      },
    ];
  }

  if (mode === "glob") {
    return [{ files: runOptions.files }];
  }

  const maxFiles = mode === "xargs" ? runOptions.step.chunk : undefined;
  return chunkFiles(runOptions.files, DEFAULT_CHUNK_BYTES, maxFiles).map(
    (files) => ({ files: [...files] }),
  );
}

async function executeTargets(
  targets: readonly InvocationTarget[],
  runOptions: StepRunOptions,
  exec: ExecFn,
  template: string,
  mode: Step["invocation"],
): Promise<readonly StepInvocation[]> {
  const runTarget = async (target: InvocationTarget): Promise<StepInvocation> => {
    const command = applyTemplate(
      template,
      templateCtx(runOptions, target.files, target.file, target.dir),
    );
    return runSingle(command, runOptions, exec, target.stdin);
  };

  if (
    mode !== "per-file" &&
    mode !== "per-directory" &&
    mode !== "per-marker-dir"
  ) {
    const invocations: StepInvocation[] = [];
    for (const target of targets) {
      invocations.push(await runTarget(target));
    }
    return invocations;
  }

  const parallel = runOptions.step.parallel ?? 1;
  const queue = [...targets];
  const invocations: StepInvocation[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const target = queue.shift();
      if (target === undefined) return;
      invocations.push(await runTarget(target));
    }
  }

  const workerCount = Math.max(1, Math.min(parallel, targets.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return invocations;
}

/**
 * Execute a step. The caller is responsible for passing an already-filtered
 * file list (via `resolveFiles` + `filterByGlob`). All shell execution is
 * routed through the injected `exec` so tests never fork real processes.
 */
export async function runStep(
  options: StepRunOptions,
  exec: ExecFn,
): Promise<StepResult> {
  const startedAt = Date.now();
  const { step } = options;
  const projectForced = options.projectForced ?? false;
  let mode = deriveEffectiveMode(step, projectForced);
  const onFailure = step["on-failure"] ?? "fail";

  // Area maps rewrite the file list before mode dispatch. A matched
  // area can replace {files} with its `run` selectors; an unmatched
  // decision may skip the step or fall through to project mode.
  // Passing `null` back means "no areas defined" — carry on.
  let effectiveFiles: readonly string[] = options.files;
  let areaDecision: AreaDecision | undefined;
  if (!projectForced) {
    const decision = resolveAreas(step, options.files);
    if (decision) {
      areaDecision = decision;
      if (decision.kind === "skip") {
        return skipped(
          decision.reason ?? "no areas matched",
          startedAt,
          decision,
          effectiveFiles,
        );
      }
      if (decision.kind === "project") {
        mode = "project";
      } else {
        effectiveFiles = decision.files;
      }
    }
  }
  const runOptions: StepRunOptions = { ...options, files: effectiveFiles };

  // Project mode: always run the project variant once, no file substitution.
  if (mode === "project") {
    const template = pickRunVariant(step.run, "project");
    if (template === null) {
      return skipped(
        "no project variant defined",
        startedAt,
        areaDecision,
        effectiveFiles,
      );
    }
    const command = applyTemplate(template, templateCtx(runOptions, []));
      const invocation = await runSingle(command, runOptions, exec);
    return result(
      [invocation],
      startedAt,
      onFailure,
      areaDecision,
      effectiveFiles,
    );
  }

  // File-scoped modes: if the list is empty, try fallback → project → skip.
  if (runOptions.files.length === 0) {
    if (step.fallback) {
      const command = applyTemplate(step.fallback, templateCtx(runOptions, []));
      const invocation = await runSingle(command, runOptions, exec);
      return result(
        [invocation],
        startedAt,
        onFailure,
        areaDecision,
        effectiveFiles,
      );
    }
    const projectTemplate = pickRunVariant(step.run, "project");
    if (typeof step.run === "object" && projectTemplate !== null) {
      const command = applyTemplate(projectTemplate, templateCtx(runOptions, []));
      const invocation = await runSingle(command, runOptions, exec);
      return result(
        [invocation],
        startedAt,
        onFailure,
        areaDecision,
        effectiveFiles,
      );
    }
    return skipped("no matching files", startedAt, areaDecision, effectiveFiles);
  }

  // Non-empty list, file-scoped mode: dispatch on invocation.
  const rawTemplate = pickRunVariant(step.run, "files");
  if (rawTemplate === null) {
    return skipped(
      "no files variant defined",
      startedAt,
      areaDecision,
      effectiveFiles,
    );
  }
  // Pin to a string-typed constant so closures below don't lose the
  // narrowing through control-flow analysis.
  const template: string = rawTemplate;
  const targets = await planInvocationTargets(runOptions, mode);
  if (
    (mode === "per-directory" || mode === "per-marker-dir") &&
    targets.length === 0
  ) {
    return skipped(
      mode === "per-directory"
        ? "no directory targets resolved"
        : "no marker directories found",
      startedAt,
      areaDecision,
      effectiveFiles,
    );
  }
  const invocations = await executeTargets(targets, runOptions, exec, template, mode);
  return result(invocations, startedAt, onFailure, areaDecision, effectiveFiles);
}
