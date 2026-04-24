import { describe, expect, test } from "bun:test";
import type { LoadedWorkspaceConfig } from "../../src/config/project.ts";
import {
  matchingWorkspacesForFile,
  pickWorkspaceForFile,
  rebaseToWorkspace,
  routeRepoFiles,
} from "../../src/runners/workspace-paths.ts";

function workspace(relativePath: string): LoadedWorkspaceConfig {
  return {
    workspaceRoot: `/repo/${relativePath}`,
    relativePath,
    basename: relativePath.split("/").at(-1) ?? relativePath,
    selectors: [relativePath, relativePath.split("/").at(-1) ?? relativePath],
    sourcePath: `/repo/${relativePath}/.config/agent-hooks.yml`,
    localPath: null,
    config: {
      name: relativePath,
      steps: {},
      pipelines: {},
    },
  };
}

describe("workspace path routing", () => {
  const workspaces = [
    workspace("services/api"),
    workspace("services/api/nested"),
    workspace("services/web"),
    workspace("packages/shared"),
  ] as const;

  test("matchingWorkspacesForFile returns every containing workspace", () => {
    expect(
      matchingWorkspacesForFile(
        "services/api/nested/src/index.ts",
        workspaces,
      ).map((item) => item.relativePath),
    ).toEqual(["services/api", "services/api/nested"]);
  });

  test("pickWorkspaceForFile chooses the shallowest match", () => {
    const picked = pickWorkspaceForFile(
      "services/api/nested/src/index.ts",
      workspaces,
    );
    expect(picked?.relativePath).toBe("services/api");
  });

  test("pickWorkspaceForFile returns null when no workspace matches", () => {
    expect(
      pickWorkspaceForFile("docs/readme.md", workspaces),
    ).toBeNull();
  });

  test("rebaseToWorkspace converts repo-relative paths to workspace-relative paths", () => {
    expect(
      rebaseToWorkspace("services/web/src/app.ts", workspace("services/web")),
    ).toBe("src/app.ts");
  });

  test("rebaseToWorkspace returns dot when the path is the workspace root itself", () => {
    expect(
      rebaseToWorkspace("packages/shared", workspace("packages/shared")),
    ).toBe(".");
  });

  test("rebaseToWorkspace returns null when the file is outside the workspace", () => {
    expect(
      rebaseToWorkspace("services/web/src/app.ts", workspace("services/api")),
    ).toBeNull();
  });

  test("routeRepoFiles partitions explicit files across multiple workspaces", () => {
    const routed = routeRepoFiles(
      [
        "services/api/src/a.ts",
        "services/web/src/b.ts",
        "packages/shared/index.ts",
      ],
      workspaces,
    );
    expect(routed.workspaces.map((entry) => entry.workspace.relativePath)).toEqual([
      "packages/shared",
      "services/api",
      "services/web",
    ]);
    expect(
      routed.workspaces.find(
        (entry) => entry.workspace.relativePath === "services/api",
      )?.workspaceFiles,
    ).toEqual(["src/a.ts"]);
    expect(
      routed.workspaces.find(
        (entry) => entry.workspace.relativePath === "services/web",
      )?.workspaceFiles,
    ).toEqual(["src/b.ts"]);
    expect(
      routed.workspaces.find(
        (entry) => entry.workspace.relativePath === "packages/shared",
      )?.workspaceFiles,
    ).toEqual(["index.ts"]);
  });

  test("routeRepoFiles preserves the root-owned repo-relative file list", () => {
    const routed = routeRepoFiles(
      ["services/api/src/a.ts", "docs/readme.md"],
      workspaces,
    );
    expect(routed.rootFiles).toEqual([
      "services/api/src/a.ts",
      "docs/readme.md",
    ]);
    expect(routed.unmatchedFiles).toEqual(["docs/readme.md"]);
  });

  test("routeRepoFiles dedupes repeated repo-relative files", () => {
    const routed = routeRepoFiles(
      ["services/web/src/b.ts", "services/web/src/b.ts"],
      workspaces,
    );
    expect(routed.rootFiles).toEqual(["services/web/src/b.ts"]);
    expect(routed.workspaces[0]?.repoFiles).toEqual(["services/web/src/b.ts"]);
    expect(routed.workspaces[0]?.workspaceFiles).toEqual(["src/b.ts"]);
  });

  test("routeRepoFiles uses the shallowest workspace for overlapping matches", () => {
    const routed = routeRepoFiles(
      ["services/api/nested/src/index.ts"],
      workspaces,
    );
    expect(routed.workspaces).toHaveLength(1);
    expect(routed.workspaces[0]?.workspace.relativePath).toBe("services/api");
    expect(routed.workspaces[0]?.workspaceFiles).toEqual([
      "nested/src/index.ts",
    ]);
  });
});
