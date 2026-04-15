/**
 * Environment resolution — runs once per pipeline invocation, before any
 * step. Layers automatic environment sources so steps don't have to care
 * whether the developer is using direnv, mise, asdf, a Python venv, or
 * raw `./node_modules/.bin`. Resolved order (later layers win on key
 * collisions), per PLAN §5.6.3:
 *
 *   1. process env (the starting point)
 *   2. direnv export json   (if `.envrc` + `direnv` on PATH)
 *   3. mise env --json      (if `.mise.toml` or `.tool-versions` + `mise`)
 *   4. asdf shims           (fallback to asdf when mise isn't installed)
 *   5. python venv          (`.venv` / `venv` / `env` with `bin/python`)
 *   6. node_modules/.bin    (when present)
 *   7. user `env:` block    (config-level — user always wins last)
 *
 * Every layer is best-effort: a parse failure or a missing tool drops
 * that source silently and records a note. Doctor reads the source list
 * to surface what fired.
 *
 * The whole resolver is injectable: tests pass an in-memory fs + a fake
 * command runner so they never shell out to direnv / mise / asdf.
 */

import nodeFs from "node:fs/promises";
import nodePath from "node:path";
import { registerChild } from "./process-registry.ts";

export type EnvSourceKind =
  | "process"
  | "direnv"
  | "mise"
  | "asdf"
  | "venv"
  | "node-bin"
  | "config";

export interface EnvSource {
  readonly kind: EnvSourceKind;
  /** Number of keys this source contributed (after merging). */
  readonly keysApplied: number;
  /** Optional human-readable detail (path, manager binary, etc.). */
  readonly detail?: string;
}

export interface ResolvedEnvironment {
  readonly env: Record<string, string>;
  readonly sources: readonly EnvSource[];
  /**
   * Notes for things that *almost* fired — e.g. `.envrc` exists but
   * `direnv` isn't on PATH. The doctor command surfaces these so users
   * can see why an expected source was skipped.
   */
  readonly notes: readonly string[];
}

export interface EnvFs {
  exists(path: string): Promise<boolean>;
}

export interface EnvCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type EnvCommandRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<EnvCommandResult>;

export interface EnvResolver {
  readonly fs: EnvFs;
  readonly run: EnvCommandRunner;
  /** Returns absolute path to a binary on PATH, or null. */
  whichCommand(name: string, env: Record<string, string>): Promise<string | null>;
}

export interface EnvResolveOptions {
  readonly cwd: string;
  /** The starting environment — usually `process.env` flattened. */
  readonly baseEnv: Record<string, string>;
  /** User-defined `env:` from config.root + per-step is layered later. */
  readonly configEnv?: Readonly<Record<string, string>>;
}

// --- Public entry point --------------------------------------------------

/**
 * Resolve the effective environment for a pipeline run by layering every
 * automatic source on top of `baseEnv`, then folding in the user's
 * config-level `env:` block last.
 */
export async function resolveEnvironment(
  options: EnvResolveOptions,
  resolver: EnvResolver,
): Promise<ResolvedEnvironment> {
  const env: Record<string, string> = { ...options.baseEnv };
  const sources: EnvSource[] = [
    { kind: "process", keysApplied: Object.keys(env).length },
  ];
  const notes: string[] = [];

  // direnv: needs both .envrc and direnv on PATH.
  const direnv = await tryDirenv(options.cwd, env, resolver);
  if (direnv.applied) {
    Object.assign(env, direnv.env);
    sources.push({
      kind: "direnv",
      keysApplied: Object.keys(direnv.env).length,
      ...(direnv.detail !== undefined ? { detail: direnv.detail } : {}),
    });
  }
  notes.push(...direnv.notes);

  // mise: prefer over asdf if both are present. Triggered by .mise.toml
  // or .tool-versions.
  const mise = await tryMise(options.cwd, env, resolver);
  if (mise.applied) {
    Object.assign(env, mise.env);
    sources.push({
      kind: "mise",
      keysApplied: Object.keys(mise.env).length,
      ...(mise.detail !== undefined ? { detail: mise.detail } : {}),
    });
  }
  notes.push(...mise.notes);

  // asdf only fires when mise didn't already cover .tool-versions.
  if (!mise.applied) {
    const asdf = await tryAsdf(options.cwd, env, resolver);
    if (asdf.applied) {
      Object.assign(env, asdf.env);
      sources.push({
        kind: "asdf",
        keysApplied: Object.keys(asdf.env).length,
        ...(asdf.detail !== undefined ? { detail: asdf.detail } : {}),
      });
    }
    notes.push(...asdf.notes);
  }

  // Python venv: any of `.venv`, `venv`, `env` with a `bin/python`.
  const venv = await tryVenv(options.cwd, env, resolver);
  if (venv.applied) {
    Object.assign(env, venv.env);
    sources.push({
      kind: "venv",
      keysApplied: Object.keys(venv.env).length,
      ...(venv.detail !== undefined ? { detail: venv.detail } : {}),
    });
  }

  // node_modules/.bin: only the prepend, no key contribution beyond PATH.
  const nodeBin = await tryNodeBin(options.cwd, env, resolver);
  if (nodeBin.applied) {
    Object.assign(env, nodeBin.env);
    sources.push({
      kind: "node-bin",
      keysApplied: 1,
      ...(nodeBin.detail !== undefined ? { detail: nodeBin.detail } : {}),
    });
  }

  // Config env wins last — user's explicit overrides beat every auto layer.
  if (options.configEnv && Object.keys(options.configEnv).length > 0) {
    for (const [k, v] of Object.entries(options.configEnv)) {
      env[k] = v;
    }
    sources.push({
      kind: "config",
      keysApplied: Object.keys(options.configEnv).length,
    });
  }

  return { env, sources, notes };
}

// --- direnv --------------------------------------------------------------

interface LayerResult {
  readonly applied: boolean;
  readonly env: Record<string, string>;
  readonly notes: readonly string[];
  readonly detail?: string;
}

async function tryDirenv(
  cwd: string,
  env: Record<string, string>,
  resolver: EnvResolver,
): Promise<LayerResult> {
  const envrcPath = nodePath.join(cwd, ".envrc");
  if (!(await resolver.fs.exists(envrcPath))) {
    return { applied: false, env: {}, notes: [] };
  }
  const direnvPath = await resolver.whichCommand("direnv", env);
  if (!direnvPath) {
    return {
      applied: false,
      env: {},
      notes: [".envrc found but `direnv` is not on PATH (skipping direnv layer)"],
    };
  }
  const result = await resolver.run(["direnv", "export", "json"], cwd);
  if (result.exitCode !== 0) {
    return {
      applied: false,
      env: {},
      notes: [
        `direnv export json failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
      ],
    };
  }
  // Empty stdout means direnv had nothing to export — that's fine, just
  // record the no-op rather than failing.
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { applied: false, env: {}, notes: [] };
  }
  const parsed = parseJsonObject(trimmed);
  if (!parsed) {
    return {
      applied: false,
      env: {},
      notes: ["direnv export json returned invalid JSON"],
    };
  }
  return {
    applied: true,
    env: parsed,
    notes: [],
    detail: direnvPath,
  };
}

// --- mise ----------------------------------------------------------------

async function tryMise(
  cwd: string,
  env: Record<string, string>,
  resolver: EnvResolver,
): Promise<LayerResult> {
  const hasMiseToml = await resolver.fs.exists(nodePath.join(cwd, ".mise.toml"));
  const hasToolVersions = await resolver.fs.exists(
    nodePath.join(cwd, ".tool-versions"),
  );
  if (!hasMiseToml && !hasToolVersions) {
    return { applied: false, env: {}, notes: [] };
  }
  const misePath = await resolver.whichCommand("mise", env);
  if (!misePath) {
    return {
      applied: false,
      env: {},
      notes: hasMiseToml
        ? [".mise.toml found but `mise` is not on PATH (skipping mise layer)"]
        : [],
    };
  }
  const result = await resolver.run(["mise", "env", "--json"], cwd);
  if (result.exitCode !== 0) {
    return {
      applied: false,
      env: {},
      notes: [
        `mise env --json failed (exit ${String(result.exitCode)}): ${result.stderr.trim()}`,
      ],
    };
  }
  const parsed = parseJsonObject(result.stdout.trim());
  if (!parsed) {
    return {
      applied: false,
      env: {},
      notes: ["mise env --json returned invalid JSON"],
    };
  }
  return { applied: true, env: parsed, notes: [], detail: misePath };
}

// --- asdf ----------------------------------------------------------------

async function tryAsdf(
  cwd: string,
  env: Record<string, string>,
  resolver: EnvResolver,
): Promise<LayerResult> {
  const hasToolVersions = await resolver.fs.exists(
    nodePath.join(cwd, ".tool-versions"),
  );
  if (!hasToolVersions) {
    return { applied: false, env: {}, notes: [] };
  }
  const asdfPath = await resolver.whichCommand("asdf", env);
  if (!asdfPath) {
    return {
      applied: false,
      env: {},
      notes: [".tool-versions found but neither `mise` nor `asdf` is on PATH"],
    };
  }
  // asdf doesn't ship an `env --json` mode. Use `asdf shellenv` (newer
  // releases) and parse export lines. Older asdf versions don't support
  // shellenv either; we treat the failure as "no env" rather than barking.
  const result = await resolver.run(["asdf", "shellenv", "sh"], cwd);
  if (result.exitCode !== 0) {
    return {
      applied: false,
      env: {},
      notes: [
        `asdf shellenv failed (exit ${String(result.exitCode)}); your asdf may be too old`,
      ],
    };
  }
  const parsed = parseShellExports(result.stdout);
  return {
    applied: Object.keys(parsed).length > 0,
    env: parsed,
    notes: [],
    detail: asdfPath,
  };
}

// --- Python venv ---------------------------------------------------------

const VENV_DIRS = [".venv", "venv", "env"] as const;

async function tryVenv(
  cwd: string,
  env: Record<string, string>,
  resolver: EnvResolver,
): Promise<LayerResult> {
  for (const dir of VENV_DIRS) {
    const venvDir = nodePath.join(cwd, dir);
    const binPython = nodePath.join(venvDir, "bin", "python");
    if (await resolver.fs.exists(binPython)) {
      const binDir = nodePath.join(venvDir, "bin");
      return {
        applied: true,
        env: {
          VIRTUAL_ENV: venvDir,
          PATH: prependPath(env.PATH ?? "", binDir),
        },
        notes: [],
        detail: venvDir,
      };
    }
  }
  return { applied: false, env: {}, notes: [] };
}

// --- node_modules/.bin ---------------------------------------------------

async function tryNodeBin(
  cwd: string,
  env: Record<string, string>,
  resolver: EnvResolver,
): Promise<LayerResult> {
  const binDir = nodePath.join(cwd, "node_modules", ".bin");
  if (!(await resolver.fs.exists(binDir))) {
    return { applied: false, env: {}, notes: [] };
  }
  return {
    applied: true,
    env: { PATH: prependPath(env.PATH ?? "", binDir) },
    notes: [],
    detail: binDir,
  };
}

// --- helpers -------------------------------------------------------------

/**
 * Prepend `dir` to `path`, idempotently — if it's already at the front
 * (or anywhere in the list) we don't double-add. Idempotency matters
 * because we may be called repeatedly during long-lived dev sessions.
 */
export function prependPath(path: string, dir: string): string {
  if (path.length === 0) return dir;
  const sep = nodePath.delimiter;
  const parts = path.split(sep);
  if (parts[0] === dir) return path;
  return `${dir}${sep}${parts.filter((p) => p !== dir).join(sep)}`;
}

/**
 * Parse JSON, returning a flat string→string record on success. Returns
 * null for anything that isn't a JSON object of string values — we never
 * want to inject nested objects into the environment.
 */
export function parseJsonObject(
  text: string,
): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
      else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    }
    return out;
  } catch {
    return null;
  }
}

// --- Default resolver (real PATH + Bun spawn) ----------------------------

async function whichOnPath(
  cmd: string,
  env: Record<string, string>,
): Promise<string | null> {
  const pathEnv = env.PATH ?? "";
  const dirs = pathEnv.split(nodePath.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = nodePath.join(dir, cmd);
    try {
      const stat = await nodeFs.stat(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // try next entry
    }
  }
  return null;
}

const defaultEnvFs: EnvFs = {
  async exists(p) {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

const defaultEnvCommandRunner: EnvCommandRunner = async (command, cwd) => {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: [...command],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { stdout: "", stderr: "spawn failed", exitCode: 127 };
  }
  const dispose = registerChild(proc);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    dispose();
  }
};

export const defaultEnvResolver: EnvResolver = {
  fs: defaultEnvFs,
  run: defaultEnvCommandRunner,
  whichCommand: whichOnPath,
};

/**
 * Parse `export FOO=bar` / `FOO=bar` lines from a shell-style env dump.
 * Quoted values are stripped of surrounding single or double quotes.
 * Lines that don't look like assignments are ignored. This is *only*
 * used for asdf shellenv — direnv and mise emit JSON.
 */
export function parseShellExports(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    // Drop a leading `export ` if present.
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    // Strip a trailing `;` from sh-style exports.
    if (value.endsWith(";")) value = value.slice(0, -1).trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
