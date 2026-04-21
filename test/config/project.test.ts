import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadProjectConfig,
  resolveWorkspaceSelector,
} from "../../src/config/project.ts";

describe("loadProjectConfig", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-project-"));

    await fs.mkdir(path.join(tmp, ".config"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".config", "agent-hooks.yml"),
      [
        "name: root",
        "workspaces:",
        "  - services/*",
        "  - packages/tools",
        "  - packages/api",
        "  - services/api/nested",
        "monorepo:",
        "  run-workspace-selection-default: affected",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmp, ".config", "agent-hooks.local.yml"),
      "name: root-local\n",
      "utf8",
    );

    await fs.mkdir(path.join(tmp, "services", "api", ".config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "services", "api", ".config", "agent-hooks.yml"),
      "name: api\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tmp, "services", "api", ".config", "agent-hooks.local.yml"),
      "name: api-local\n",
      "utf8",
    );

    await fs.mkdir(path.join(tmp, "services", "web", ".config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "services", "web", ".config", "agent-hooks.yml"),
      "name: web\n",
      "utf8",
    );

    await fs.mkdir(path.join(tmp, "packages", "tools", ".config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "packages", "tools", ".config", "agent-hooks.yml"),
      "name: tools\n",
      "utf8",
    );

    await fs.mkdir(path.join(tmp, "packages", "api", ".config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "packages", "api", ".config", "agent-hooks.yml"),
      "name: package-api\n",
      "utf8",
    );

    await fs.mkdir(path.join(tmp, "services", "api", "nested", ".config"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "services", "api", "nested", ".config", "agent-hooks.yml"),
      "name: nested\n",
      "utf8",
    );

  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("falls back to single-project mode when no parent root manifest exists", async () => {
    const single = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-single-"));
    try {
      await fs.mkdir(path.join(single, ".config"), { recursive: true });
      await fs.writeFile(
        path.join(single, ".config", "agent-hooks.yml"),
        "name: standalone\n",
        "utf8",
      );
      const loaded = await loadProjectConfig({ cwd: single });
      expect(loaded.mode).toBe("single");
      if (loaded.mode === "single") {
        expect(loaded.loaded.config.name).toBe("standalone");
      }
    } finally {
      await fs.rm(single, { recursive: true, force: true });
    }
  });

  test("loads the parent monorepo root and discovers workspace configs from globs and explicit paths", async () => {
    const loaded = await loadProjectConfig({ cwd: tmp });
    expect(loaded.mode).toBe("monorepo");
    if (loaded.mode !== "monorepo") return;
    expect(loaded.root.config.name).toBe("root-local");
    expect(loaded.workspaces.map((workspace) => workspace.relativePath)).toEqual([
      "packages/api",
      "packages/tools",
      "services/api",
      "services/api/nested",
      "services/web",
    ]);
    expect(loaded.workspaces.map((workspace) => workspace.config.name)).toEqual([
      "package-api",
      "tools",
      "api-local",
      "nested",
      "web",
    ]);
  });

  test("invoking from a workspace subtree still finds the parent root and current workspace", async () => {
    const cwd = path.join(tmp, "services", "api", "src");
    await fs.mkdir(cwd, { recursive: true });
    const loaded = await loadProjectConfig({ cwd });
    expect(loaded.mode).toBe("monorepo");
    if (loaded.mode !== "monorepo") return;
    expect(loaded.currentWorkspace?.relativePath).toBe("services/api");
  });

  test("overlapping nested workspaces warn and the shallowest current workspace wins", async () => {
    const cwd = path.join(tmp, "services", "api", "nested", "src");
    await fs.mkdir(cwd, { recursive: true });
    const loaded = await loadProjectConfig({ cwd });
    expect(loaded.mode).toBe("monorepo");
    if (loaded.mode !== "monorepo") return;
    expect(loaded.currentWorkspace?.relativePath).toBe("services/api");
    expect(
      loaded.warnings.some((warning) =>
        warning.includes("services/api/nested is nested under services/api"),
      ),
    ).toBe(true);
  });

  test("resolves workspace selectors by relative path or basename and reports ambiguity", async () => {
    const loaded = await loadProjectConfig({ cwd: tmp });
    expect(loaded.mode).toBe("monorepo");
    if (loaded.mode !== "monorepo") return;

    const byPath = resolveWorkspaceSelector(loaded.workspaces, "services/api");
    expect(byPath.status).toBe("ok");
    if (byPath.status === "ok") {
      expect(byPath.workspace.relativePath).toBe("services/api");
    }

    const byBase = resolveWorkspaceSelector(loaded.workspaces, "web");
    expect(byBase.status).toBe("ok");
    if (byBase.status === "ok") {
      expect(byBase.workspace.relativePath).toBe("services/web");
    }

    const ambiguous = resolveWorkspaceSelector(loaded.workspaces, "api");
    expect(ambiguous.status).toBe("ambiguous");
  });
});
