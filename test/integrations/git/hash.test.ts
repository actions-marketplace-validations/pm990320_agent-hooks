import { describe, expect, test } from "bun:test";
import {
  configHash,
  monorepoConfigHash,
  projectHookNames,
} from "../../../src/integrations/git/hash.ts";
import type { LoadedMonorepoProject } from "../../../src/config/project.ts";
import { ConfigSchema } from "../../../src/config/schema.ts";

describe("configHash", () => {
  test("is stable across invocations for the same config", () => {
    const config = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
    });
    expect(configHash(config)).toBe(configHash(config));
  });

  test("changes when the git section changes", () => {
    const a = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "a" } } },
    });
    const b = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "b" } } },
    });
    expect(configHash(a)).not.toBe(configHash(b));
  });

  test("treats missing git section as stable", () => {
    const a = ConfigSchema.parse({});
    const b = ConfigSchema.parse({});
    expect(configHash(a)).toBe(configHash(b));
  });

  test("returns a 64-character hex digest", () => {
    const config = ConfigSchema.parse({});
    expect(configHash(config)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("monorepo hash changes when a workspace git hook changes", () => {
    const root = ConfigSchema.parse({
      workspaces: ["services/*"],
      git: { hooks: { "pre-commit": { pipeline: "root-pre-commit" } } },
    });
    const workspaceA = ConfigSchema.parse({
      git: { hooks: { "pre-push": { pipeline: "workspace-pre-push" } } },
    });
    const workspaceB = ConfigSchema.parse({
      git: { hooks: { "pre-push": { pipeline: "workspace-pre-push-2" } } },
    });

    const makeProject = (workspaceConfig: typeof workspaceA): LoadedMonorepoProject => ({
      mode: "monorepo",
      repoRoot: "/repo",
      root: {
        config: root,
        sourcePath: "/repo/.config/agent-hooks.yml",
        localPath: null,
      },
      workspaces: [
        {
          config: workspaceConfig,
          sourcePath: "/repo/services/api/.config/agent-hooks.yml",
          localPath: null,
          workspaceRoot: "/repo/services/api",
          relativePath: "services/api",
          basename: "api",
          selectors: ["services/api", "api"],
        },
      ],
      currentWorkspace: null,
      warnings: [],
    });

    expect(monorepoConfigHash(makeProject(workspaceA))).not.toBe(
      monorepoConfigHash(makeProject(workspaceB)),
    );
  });

  test("projectHookNames unions root and workspace hook names", () => {
    const project: LoadedMonorepoProject = {
      mode: "monorepo",
      repoRoot: "/repo",
      root: {
        config: ConfigSchema.parse({
          workspaces: ["services/*"],
          git: { hooks: { "pre-commit": { pipeline: "root-pre-commit" } } },
        }),
        sourcePath: "/repo/.config/agent-hooks.yml",
        localPath: null,
      },
      workspaces: [
        {
          config: ConfigSchema.parse({
            git: {
              hooks: {
                "pre-push": { pipeline: "workspace-pre-push" },
                "pre-commit": { pipeline: "workspace-pre-commit" },
              },
            },
          }),
          sourcePath: "/repo/services/api/.config/agent-hooks.yml",
          localPath: null,
          workspaceRoot: "/repo/services/api",
          relativePath: "services/api",
          basename: "api",
          selectors: ["services/api", "api"],
        },
      ],
      currentWorkspace: null,
      warnings: [],
    };

    expect(projectHookNames(project)).toEqual(["pre-commit", "pre-push"]);
  });
});
