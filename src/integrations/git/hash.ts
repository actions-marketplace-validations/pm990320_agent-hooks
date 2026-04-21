import { createHash } from "node:crypto";
import type {
  LoadedMonorepoProject,
  LoadedProject,
} from "../../config/project.ts";
import type { Config } from "../../config/schema.ts";

/**
 * Compute a stable SHA256 hash of a subset of the config that affects
 * git-hook stub generation. Currently this is just the `git` section,
 * but it's isolated here so we can expand the inputs later without
 * invalidating the hash-header semantics inside stub files.
 */
export function configHash(config: Config): string {
  const payload = JSON.stringify({ git: config.git ?? null });
  return createHash("sha256").update(payload).digest("hex");
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function hookNamesForConfig(config: Config): string[] {
  if (!config.git?.hooks) return [];
  return Object.keys(config.git.hooks)
    .filter((name) => config.git?.hooks?.[name] !== undefined)
    .sort();
}

export function projectHookNames(project: LoadedMonorepoProject): string[] {
  const names = new Set<string>(hookNamesForConfig(project.root.config));
  for (const workspace of project.workspaces) {
    for (const name of hookNamesForConfig(workspace.config)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

export function monorepoConfigHash(project: LoadedMonorepoProject): string {
  return hashPayload({
    root: {
      workspaces: project.root.config.workspaces ?? [],
      monorepo: project.root.config.monorepo ?? null,
      git: project.root.config.git ?? null,
    },
    workspaces: project.workspaces.map((workspace) => ({
      relativePath: workspace.relativePath,
      git: workspace.config.git ?? null,
    })),
  });
}

export function projectConfigHash(project: LoadedProject): string {
  if (project.mode === "single") return configHash(project.loaded.config);
  return monorepoConfigHash(project);
}
