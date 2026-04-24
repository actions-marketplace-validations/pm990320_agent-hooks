import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const nodeFs = await import("node:fs/promises");

const SKILL_TEMPLATE_RELATIVE_PATH = path.join(
  "templates",
  "skills",
  "agent-hooks.skill.md",
);

export function skillTemplateCandidates(moduleUrl = import.meta.url): readonly string[] {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  return [
    // Source layout: src/integrations/skill/install.ts → repo root.
    path.join(moduleDir, "..", "..", "..", SKILL_TEMPLATE_RELATIVE_PATH),
    // Bundled npm layout: dist/index.js → package root.
    path.join(moduleDir, "..", SKILL_TEMPLATE_RELATIVE_PATH),
  ];
}

/**
 * Load the shipped skill template from the package's `templates/skills/`
 * directory. Source runs resolve from `src/integrations/skill/`; bundled
 * npm runs resolve from `dist/`. Use `import.meta.url` rather than
 * Bun-only `import.meta.dir` so the published Node entrypoint works too.
 */
export async function loadSkillTemplate(): Promise<string> {
  const attemptedPaths: string[] = [];
  for (const templatePath of skillTemplateCandidates()) {
    attemptedPaths.push(templatePath);
    try {
      return await nodeFs.readFile(templatePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }
  throw new Error(
    `agent-hooks skill template not found; tried ${attemptedPaths.join(", ")}`,
  );
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
  mkdirRecursive(dirPath: string): Promise<void>;
  write(filePath: string, contents: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  remove(filePath: string): Promise<void>;
}

export const defaultSkillFs: SkillFs = {
  async mkdirRecursive(dirPath) {
    await nodeFs.mkdir(dirPath, { recursive: true });
  },
  async write(filePath, contents) {
    await nodeFs.writeFile(filePath, contents, "utf8");
  },
  async exists(filePath) {
    try {
      await nodeFs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  async remove(filePath) {
    await nodeFs.unlink(filePath);
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
