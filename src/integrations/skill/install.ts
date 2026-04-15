import path from "node:path";
import os from "node:os";

const nodeFs = await import("node:fs/promises");

/**
 * Load the shipped skill template from the package's `templates/skills/`
 * directory. We resolve the path relative to this module so the same
 * code works whether we're running from source (via `bun src/index.ts`)
 * or from a bundled dist.
 */
export async function loadSkillTemplate(): Promise<string> {
  const templatePath = path.join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "templates",
    "skills",
    "agent-hooks.skill.md",
  );
  return nodeFs.readFile(templatePath, "utf8");
}

export type SkillTarget = "claude" | "cursor" | "codex";

export interface SkillInstallPaths {
  readonly dir: string;
  readonly filePath: string;
}

/**
 * Compute where to install the skill for the given agent. Scope can be
 * `user` (home directory) or `project` (repo-local). Each agent has a
 * slightly different convention; the returned `filePath` is what we
 * write the skill content to.
 */
export function resolveSkillPaths(
  target: SkillTarget,
  scope: "user" | "project",
  repoCwd: string,
): SkillInstallPaths {
  const home = os.homedir();

  if (target === "claude") {
    const root =
      scope === "project"
        ? path.join(repoCwd, ".claude", "skills", "agent-hooks")
        : path.join(home, ".claude", "skills", "agent-hooks");
    return { dir: root, filePath: path.join(root, "SKILL.md") };
  }

  if (target === "cursor") {
    const root =
      scope === "project"
        ? path.join(repoCwd, ".cursor", "skills")
        : path.join(home, ".cursor", "skills");
    return {
      dir: root,
      filePath: path.join(root, "agent-hooks.md"),
    };
  }

  // codex
  const root =
    scope === "project"
      ? path.join(repoCwd, ".codex", "skills")
      : path.join(home, ".codex", "skills");
  return {
    dir: root,
    filePath: path.join(root, "agent-hooks.md"),
  };
}

export interface SkillFs {
  mkdirRecursive(p: string): Promise<void>;
  write(p: string, contents: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  remove(p: string): Promise<void>;
}

export const defaultSkillFs: SkillFs = {
  async mkdirRecursive(p) {
    await nodeFs.mkdir(p, { recursive: true });
  },
  async write(p, contents) {
    await nodeFs.writeFile(p, contents, "utf8");
  },
  async exists(p) {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async remove(p) {
    await nodeFs.unlink(p);
  },
};

export interface InstallSkillOptions {
  readonly target: SkillTarget;
  readonly scope: "user" | "project";
  readonly repoCwd: string;
  readonly fs: SkillFs;
  readonly loadTemplate?: () => Promise<string>;
}

export interface InstallSkillResult {
  readonly filePath: string;
  readonly wrote: boolean;
}

export async function installSkill(
  options: InstallSkillOptions,
): Promise<InstallSkillResult> {
  const paths = resolveSkillPaths(
    options.target,
    options.scope,
    options.repoCwd,
  );
  const template = await (options.loadTemplate ?? loadSkillTemplate)();
  await options.fs.mkdirRecursive(paths.dir);
  await options.fs.write(paths.filePath, template);
  return { filePath: paths.filePath, wrote: true };
}

export async function uninstallSkill(
  options: InstallSkillOptions,
): Promise<{ filePath: string; removed: boolean }> {
  const paths = resolveSkillPaths(
    options.target,
    options.scope,
    options.repoCwd,
  );
  if (await options.fs.exists(paths.filePath)) {
    await options.fs.remove(paths.filePath);
    return { filePath: paths.filePath, removed: true };
  }
  return { filePath: paths.filePath, removed: false };
}
