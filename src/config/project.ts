import path from "node:path";
import picomatch from "picomatch";
import {
  CONFIG_CANDIDATES,
  configRootDir,
  findFirstInDir,
  loadConfig,
  loadConfigFromPath,
  type LoadedConfig,
  type LoaderFs,
} from "./load.ts";

export interface ProjectFs extends LoaderFs {
  listDir(dir: string): Promise<readonly string[]>;
  isDirectory(dir: string): Promise<boolean>;
}

const nodeFs = await import("node:fs/promises");

export const defaultProjectFs: ProjectFs = {
  async exists(filePath) {
    try {
      await nodeFs.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
  read(filePath) {
    return nodeFs.readFile(filePath, "utf8");
  },
  async listDir(dir) {
    try {
      return await nodeFs.readdir(dir);
    } catch {
      return [];
    }
  },
  async isDirectory(dir) {
    try {
      return (await nodeFs.stat(dir)).isDirectory();
    } catch {
      return false;
    }
  },
};

export interface WorkspaceWarnings {
  readonly warnings: readonly string[];
}

export interface LoadedWorkspaceConfig extends LoadedConfig {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly basename: string;
  readonly selectors: readonly string[];
}

export interface LoadedMonorepoProject extends WorkspaceWarnings {
  readonly mode: "monorepo";
  readonly repoRoot: string;
  readonly root: LoadedConfig;
  readonly workspaces: readonly LoadedWorkspaceConfig[];
  readonly currentWorkspace: LoadedWorkspaceConfig | null;
}

export interface LoadedSingleProject {
  readonly mode: "single";
  readonly loaded: LoadedConfig;
}

export type LoadedProject = LoadedSingleProject | LoadedMonorepoProject;

export interface LoadProjectOptions {
  readonly cwd?: string;
  readonly fs?: ProjectFs;
}

export type WorkspaceSelectorResolution =
  | { readonly status: "ok"; readonly workspace: LoadedWorkspaceConfig }
  | {
      readonly status: "ambiguous";
      readonly matches: readonly LoadedWorkspaceConfig[];
    }
  | { readonly status: "missing" };

function normalizeRel(value: string): string {
  return value.replaceAll(path.sep, "/");
}

function pathDepth(rel: string): number {
  return normalizeRel(rel).split("/").filter((part) => part.length > 0).length;
}

function hasGlobMagic(pattern: string): boolean {
  return /[*?[\]{}()!+@]/.test(pattern);
}

function isSameOrChildPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(`${parent}/`);
}

async function listRelativeDirectories(
  root: string,
  fs: ProjectFs,
): Promise<readonly string[]> {
  const out: string[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    for (const entry of await fs.listDir(absDir)) {
      if (entry === ".git" || entry === "node_modules") continue;
      const abs = path.join(absDir, entry);
      if (!(await fs.isDirectory(abs))) continue;
      const rel = relDir.length > 0 ? `${relDir}/${entry}` : entry;
      out.push(rel);
      await walk(abs, rel);
    }
  }
  await walk(root, "");
  return out;
}

async function findMonorepoRoot(
  cwd: string,
  fs: ProjectFs,
): Promise<LoadedConfig | null> {
  let dir = path.resolve(cwd);
  let found: LoadedConfig | null = null;
  for (;;) {
    const sourcePath = await findFirstInDir(dir, CONFIG_CANDIDATES, fs);
    if (sourcePath) {
      const loaded = await loadConfigFromPath(sourcePath, fs);
      if ((loaded.config.workspaces?.length ?? 0) > 0) {
        found = loaded;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

function workspaceWarnings(
  workspaces: readonly LoadedWorkspaceConfig[],
  cwdRel: string | null,
): string[] {
  const warnings: string[] = [];
  const sorted = [...workspaces].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
  for (let i = 0; i < sorted.length; i += 1) {
    const left = sorted[i];
    if (!left) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const right = sorted[j];
      if (!right) continue;
      if (isSameOrChildPath(left.relativePath, right.relativePath)) {
        warnings.push(
          `workspace overlap: ${right.relativePath} is nested under ${left.relativePath}; shallowest match wins`,
        );
      }
    }
  }
  if (cwdRel) {
    const matches = workspaces.filter((workspace) =>
      isSameOrChildPath(workspace.relativePath, cwdRel),
    );
    if (matches.length > 1) {
      const names = matches.map((workspace) => workspace.relativePath).join(", ");
      warnings.push(
        `cwd matches multiple workspaces (${names}); shallowest match wins`,
      );
    }
  }
  return warnings;
}

function pickCurrentWorkspace(
  cwd: string,
  repoRoot: string,
  workspaces: readonly LoadedWorkspaceConfig[],
): LoadedWorkspaceConfig | null {
  const rel = normalizeRel(path.relative(repoRoot, path.resolve(cwd)));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const matches = workspaces
    .filter((workspace) => isSameOrChildPath(workspace.relativePath, rel))
    .sort((a, b) => pathDepth(a.relativePath) - pathDepth(b.relativePath));
  return matches[0] ?? null;
}

export function resolveWorkspaceSelector(
  workspaces: readonly LoadedWorkspaceConfig[],
  selector: string,
): WorkspaceSelectorResolution {
  const normalized = normalizeRel(selector);
  const byPath = workspaces.find(
    (workspace) => workspace.relativePath === normalized,
  );
  if (byPath) return { status: "ok", workspace: byPath };
  const byBase = workspaces.filter((workspace) => workspace.basename === normalized);
  if (byBase.length === 1) {
    const workspace = byBase[0];
    if (!workspace) return { status: "missing" };
    return { status: "ok", workspace };
  }
  if (byBase.length > 1) {
    return { status: "ambiguous", matches: byBase };
  }
  return { status: "missing" };
}

async function discoverWorkspaceRoots(
  repoRoot: string,
  patterns: readonly string[],
  fs: ProjectFs,
): Promise<readonly string[]> {
  const relDirs = await listRelativeDirectories(repoRoot, fs);
  const found = new Set<string>();
  for (const pattern of patterns) {
    const normalized = normalizeRel(pattern);
    if (!hasGlobMagic(normalized)) {
      const abs = path.join(repoRoot, normalized);
      if (await fs.isDirectory(abs)) found.add(normalized);
      continue;
    }
    const matches = picomatch(normalized, { dot: true });
    for (const relDir of relDirs) {
      if (matches(relDir)) found.add(relDir);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

export async function loadProjectConfig(
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const cwd = options.cwd ?? process.cwd();
  const fs = options.fs ?? defaultProjectFs;
  const root = await findMonorepoRoot(cwd, fs);
  if (!root) {
    return { mode: "single", loaded: await loadConfig({ cwd, fs }) };
  }

  const repoRoot = configRootDir(root.sourcePath);
  const workspaceRoots = await discoverWorkspaceRoots(
    repoRoot,
    root.config.workspaces ?? [],
    fs,
  );

  const workspaces: LoadedWorkspaceConfig[] = [];
  const warnings: string[] = [];

  for (const relRoot of workspaceRoots) {
    const workspaceRoot = path.join(repoRoot, relRoot);
    const sourcePath = await findFirstInDir(workspaceRoot, CONFIG_CANDIDATES, fs);
    if (!sourcePath) {
      warnings.push(
        `workspace ${relRoot} matched by root workspaces but has no config file`,
      );
      continue;
    }
    const loaded = await loadConfigFromPath(sourcePath, fs);
    workspaces.push({
      ...loaded,
      workspaceRoot,
      relativePath: relRoot,
      basename: path.basename(relRoot),
      selectors: [relRoot, path.basename(relRoot)],
    });
  }

  const currentWorkspace = pickCurrentWorkspace(cwd, repoRoot, workspaces);
  return {
    mode: "monorepo",
    repoRoot,
    root,
    workspaces,
    currentWorkspace,
    warnings: [
      ...warnings,
      ...workspaceWarnings(
        workspaces,
        normalizeRel(path.relative(repoRoot, path.resolve(cwd))),
      ),
    ],
  };
}
