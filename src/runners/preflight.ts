import nodeFs from "node:fs/promises";
import path from "node:path";
import type { Step } from "../config/schema.ts";

/**
 * Filesystem + PATH lookup surface for preflight checks. Injected so
 * unit tests can simulate missing tools without touching real env.
 */
export interface PreflightFs {
  exists(p: string): Promise<boolean>;
}

export interface PreflightResolver {
  /** Look up an executable on PATH; return absolute path or null. */
  whichCommand(name: string): Promise<string | null>;
  /** Read an environment variable; null when unset. */
  getEnv(name: string): string | null;
  /** Filesystem adapter for `path:` and `file:` checks. */
  readonly fs: PreflightFs;
}

export interface PreflightFailure {
  /** Human-readable description of what was missing. */
  readonly reason: string;
}

export interface PreflightDecision {
  readonly ok: boolean;
  readonly failures: readonly PreflightFailure[];
}

/**
 * Walk a step's `requires` list and return a decision describing every
 * unmet check. Returns `{ ok: true, failures: [] }` when the step has
 * no `requires` block — preflight is opt-in.
 */
export async function evaluatePreflight(
  step: Step,
  cwd: string,
  resolver: PreflightResolver,
): Promise<PreflightDecision> {
  const failures: PreflightFailure[] = [];
  for (const req of step.requires) {
    if ("command" in req) {
      const found = await resolver.whichCommand(req.command);
      if (!found) {
        failures.push({ reason: `command not on PATH: ${req.command}` });
      }
    } else if ("path" in req) {
      const abs = path.isAbsolute(req.path)
        ? req.path
        : path.join(cwd, req.path);
      if (!(await resolver.fs.exists(abs))) {
        failures.push({ reason: `path missing: ${req.path}` });
      }
    } else if ("file" in req) {
      const abs = path.isAbsolute(req.file)
        ? req.file
        : path.join(cwd, req.file);
      if (!(await resolver.fs.exists(abs))) {
        failures.push({ reason: `file missing: ${req.file}` });
      }
    } else if ("env" in req) {
      if (resolver.getEnv(req.env) === null) {
        failures.push({ reason: `env var unset: ${req.env}` });
      }
    } else if ("node-modules" in req) {
      const abs = path.join(cwd, "node_modules");
      if (!(await resolver.fs.exists(abs))) {
        failures.push({ reason: "node_modules/ not present" });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Pick the effective `on-missing` policy for a step in a given context.
 *
 *   - Per-step `on-missing` always wins when set.
 *   - Otherwise: git/agent hook contexts → warn-skip (don't block), CI
 *     and explicit CLI runs → fail.
 */
export type PreflightContext = "git-hook" | "agent-hook" | "manual" | "ci";

export type PreflightPolicy = "warn" | "warn-skip" | "skip" | "fail";

export function resolvePreflightPolicy(
  step: Step,
  context: PreflightContext,
): PreflightPolicy {
  if (step["on-missing"]) return step["on-missing"];
  if (context === "git-hook" || context === "agent-hook") return "warn-skip";
  return "fail";
}

// --- Default resolver (real PATH + filesystem) ---------------------------

async function which(cmd: string): Promise<string | null> {
  // POSIX `command -v <name>` / Windows `where`. We avoid spawning when
  // PATH is empty.
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = path.join(dir, cmd);
    try {
      const stat = await nodeFs.stat(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // try next entry
    }
  }
  return null;
}

export const defaultPreflightResolver: PreflightResolver = {
  whichCommand: which,
  getEnv: (name) => process.env[name] ?? null,
  fs: {
    async exists(p) {
      try {
        await nodeFs.access(p);
        return true;
      } catch {
        return false;
      }
    },
  },
};
