import path from "node:path";
import type { Config } from "../../config/schema.ts";
import { configHash } from "./hash.ts";
import { buildStub, inspectStub } from "./stub.ts";

export type InstallStatus =
  | "wrote"
  | "updated"
  | "skipped-same-hash"
  | "skipped-foreign"
  | "replaced-foreign"
  | "removed-stale";

export interface HookInstallOutcome {
  readonly hookName: string;
  readonly status: InstallStatus;
  readonly path: string;
}

export interface InstallResult {
  readonly hash: string;
  readonly outcomes: readonly HookInstallOutcome[];
  /** True when nothing on disk needed to change. Used by `--if-missing`. */
  readonly allUpToDate: boolean;
}

/**
 * Filesystem surface we depend on. Injected so unit tests can run
 * against an in-memory map.
 */
export interface HookFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string, mode: number): Promise<void>;
  mkdirRecursive(p: string): Promise<void>;
  remove(p: string): Promise<void>;
}

export interface InstallOptions {
  readonly gitRoot: string;
  readonly config: Config;
  readonly fs: HookFs;
  /**
   * How to handle a `.git/hooks/<name>` that already exists and is NOT
   * managed by agent-hooks.
   *
   *   - `skip` *(default)* — leave the foreign hook alone, record
   *     `skipped-foreign`
   *   - `replace` — overwrite (caller is responsible for having asked
   *     the user first)
   */
  readonly foreignHookPolicy?: "skip" | "replace";
  /**
   * If true, skip installing when every expected hook already exists
   * with a matching config hash. Used by `install --if-missing`.
   */
  readonly ifMissing?: boolean;
}

const STUB_MODE = 0o755;

function hookPath(gitRoot: string, name: string): string {
  return path.join(gitRoot, ".git", "hooks", name);
}

function expectedHookNames(config: Config): string[] {
  if (!config.git?.hooks) return [];
  return Object.keys(config.git.hooks).filter(
    (name) => config.git?.hooks?.[name] !== undefined,
  );
}

/**
 * Remove any stubs we previously installed that are no longer listed in
 * the config. Foreign hooks (no managed header) are left untouched.
 */
async function removeOrphans(
  options: InstallOptions,
  expected: ReadonlySet<string>,
  outcomes: HookInstallOutcome[],
): Promise<void> {
  const hooksDir = path.join(options.gitRoot, ".git", "hooks");
  // We can't list the directory without a filesystem `readdir`. For the
  // injectable HookFs we keep things simple: only remove stubs named in
  // the known set of git hook names.
  const knownHookNames = [
    "applypatch-msg",
    "pre-applypatch",
    "post-applypatch",
    "pre-commit",
    "pre-merge-commit",
    "prepare-commit-msg",
    "commit-msg",
    "post-commit",
    "pre-rebase",
    "post-checkout",
    "post-merge",
    "pre-push",
    "post-rewrite",
    "pre-auto-gc",
    "sendemail-validate",
    "fsmonitor-watchman",
    "post-index-change",
  ];
  for (const name of knownHookNames) {
    if (expected.has(name)) continue;
    const p = path.join(hooksDir, name);
    if (!(await options.fs.exists(p))) continue;
    const existing = await options.fs.read(p);
    const info = inspectStub(existing);
    if (info.managed) {
      await options.fs.remove(p);
      outcomes.push({ hookName: name, status: "removed-stale", path: p });
    }
  }
}

export async function installHooks(
  options: InstallOptions,
): Promise<InstallResult> {
  const hash = configHash(options.config);
  const expected = expectedHookNames(options.config);
  const expectedSet = new Set(expected);
  const outcomes: HookInstallOutcome[] = [];

  await options.fs.mkdirRecursive(path.join(options.gitRoot, ".git", "hooks"));

  for (const name of expected) {
    const p = hookPath(options.gitRoot, name);
    const exists = await options.fs.exists(p);

    if (!exists) {
      if (options.ifMissing === true) {
        // Even with --if-missing, missing hooks need to be written — it
        // only short-circuits when everything is already in place.
      }
      await options.fs.write(p, buildStub(name, hash), STUB_MODE);
      outcomes.push({ hookName: name, status: "wrote", path: p });
      continue;
    }

    const existing = await options.fs.read(p);
    const info = inspectStub(existing);

    if (!info.managed) {
      if (options.foreignHookPolicy === "replace") {
        await options.fs.write(p, buildStub(name, hash), STUB_MODE);
        outcomes.push({ hookName: name, status: "replaced-foreign", path: p });
      } else {
        outcomes.push({ hookName: name, status: "skipped-foreign", path: p });
      }
      continue;
    }

    if (info.configHash === hash) {
      outcomes.push({ hookName: name, status: "skipped-same-hash", path: p });
      continue;
    }

    await options.fs.write(p, buildStub(name, hash), STUB_MODE);
    outcomes.push({ hookName: name, status: "updated", path: p });
  }

  await removeOrphans(options, expectedSet, outcomes);

  const allUpToDate = outcomes.every(
    (o) =>
      o.status === "skipped-same-hash" ||
      o.status === "skipped-foreign",
  );

  return { hash, outcomes, allUpToDate };
}

// --- Default filesystem adapter ------------------------------------------

const nodeFs = await import("node:fs/promises");

export const defaultHookFs: HookFs = {
  async exists(p) {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async read(p) {
    return nodeFs.readFile(p, "utf8");
  },
  async write(p, contents, mode) {
    await nodeFs.writeFile(p, contents, "utf8");
    await nodeFs.chmod(p, mode);
  },
  async mkdirRecursive(p) {
    await nodeFs.mkdir(p, { recursive: true });
  },
  async remove(p) {
    await nodeFs.unlink(p);
  },
};
