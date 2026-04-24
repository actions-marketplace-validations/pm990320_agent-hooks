import path from "node:path";
import type { LoadedWorkspaceConfig } from "../config/project.ts";

export interface WorkspaceRoutedFiles {
  readonly workspace: LoadedWorkspaceConfig;
  /** Matched files in repo-relative form. */
  readonly repoFiles: readonly string[];
  /** Same files rebased to the workspace root. */
  readonly workspaceFiles: readonly string[];
}

export interface RoutedRepoFiles {
  /**
   * Root-owned targets keep the original repo-relative file list. This
   * means coordinated callers can hand the same input to root pipelines
   * without rebasing or losing cross-workspace context.
   */
  readonly rootFiles: readonly string[];
  /** Files that matched at least one workspace, grouped by workspace. */
  readonly workspaces: readonly WorkspaceRoutedFiles[];
  /** Repo-relative files that matched no workspace. */
  readonly unmatchedFiles: readonly string[];
}

function normalizeRel(file: string): string {
  return file.replaceAll(path.sep, "/");
}

function depth(rel: string): number {
  return normalizeRel(rel).split("/").filter((part) => part.length > 0).length;
}

function isSameOrChild(root: string, file: string): boolean {
  const normalizedRoot = normalizeRel(root);
  const normalizedFile = normalizeRel(file);
  return (
    normalizedFile === normalizedRoot ||
    normalizedFile.startsWith(`${normalizedRoot}/`)
  );
}

function dedupe(files: readonly string[]): readonly string[] {
  return [...new Set(files.filter((file) => file.length > 0).map(normalizeRel))];
}

/**
 * Return every workspace whose relative root contains the repo-relative file.
 * Callers that need the routing winner should use `pickWorkspaceForFile()`.
 */
export function matchingWorkspacesForFile(
  file: string,
  workspaces: readonly LoadedWorkspaceConfig[],
): readonly LoadedWorkspaceConfig[] {
  const normalizedFile = normalizeRel(file);
  return workspaces.filter((workspace) =>
    isSameOrChild(workspace.relativePath, normalizedFile),
  );
}

/**
 * Routing policy for overlaps: the shallowest workspace wins. This matches the
 * monorepo design note and lets callers separately surface warnings.
 */
export function pickWorkspaceForFile(
  file: string,
  workspaces: readonly LoadedWorkspaceConfig[],
): LoadedWorkspaceConfig | null {
  const matches = [...matchingWorkspacesForFile(file, workspaces)].sort(
    (left: LoadedWorkspaceConfig, right: LoadedWorkspaceConfig) =>
      depth(left.relativePath) - depth(right.relativePath),
  );
  return matches[0] ?? null;
}

/**
 * Rebase a repo-relative file path to the workspace root. Returns null when
 * the file does not belong to that workspace.
 */
export function rebaseToWorkspace(
  file: string,
  workspace: Pick<LoadedWorkspaceConfig, "relativePath">,
): string | null {
  const normalizedFile = normalizeRel(file);
  const normalizedRoot = normalizeRel(workspace.relativePath);
  if (!isSameOrChild(normalizedRoot, normalizedFile)) return null;
  if (normalizedFile === normalizedRoot) return ".";
  return normalizedFile.slice(normalizedRoot.length + 1);
}

/**
 * Partition repo-relative files across workspaces while preserving the
 * original repo-relative list for root-owned targets.
 */
export function routeRepoFiles(
  files: readonly string[],
  workspaces: readonly LoadedWorkspaceConfig[],
): RoutedRepoFiles {
  const rootFiles = dedupe(files);
  const unmatchedFiles: string[] = [];
  const perWorkspace = new Map<string, WorkspaceRoutedFiles>();

  for (const file of rootFiles) {
    const workspace = pickWorkspaceForFile(file, workspaces);
    if (!workspace) {
      unmatchedFiles.push(file);
      continue;
    }
    const rebased = rebaseToWorkspace(file, workspace);
    if (rebased === null) {
      unmatchedFiles.push(file);
      continue;
    }
    const existing = perWorkspace.get(workspace.relativePath);
    if (existing) {
      (existing.repoFiles as string[]).push(file);
      (existing.workspaceFiles as string[]).push(rebased);
      continue;
    }
    perWorkspace.set(workspace.relativePath, {
      workspace,
      repoFiles: [file],
      workspaceFiles: [rebased],
    });
  }

  return {
    rootFiles,
    workspaces: [...perWorkspace.values()].sort((left, right) =>
      left.workspace.relativePath.localeCompare(right.workspace.relativePath),
    ),
    unmatchedFiles,
  };
}
