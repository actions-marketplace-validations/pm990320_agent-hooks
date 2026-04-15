import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultSkillFs,
  installSkill,
  loadSkillTemplate,
  resolveSkillPaths,
  uninstallSkill,
  type SkillFs,
} from "../../../src/integrations/skill/install.ts";

function memFs(): SkillFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    mkdirRecursive: () => Promise.resolve(),
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    remove: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
  };
}

describe("resolveSkillPaths", () => {
  test("claude user scope → ~/.claude/skills/agent-hooks/SKILL.md", () => {
    const paths = resolveSkillPaths("claude", "user", "/repo");
    expect(paths.filePath).toContain(".claude/skills/agent-hooks/SKILL.md");
    expect(paths.filePath).not.toContain("/repo/");
  });

  test("claude project scope → <repo>/.claude/skills/agent-hooks/SKILL.md", () => {
    const paths = resolveSkillPaths("claude", "project", "/repo");
    expect(paths.filePath).toBe(
      "/repo/.claude/skills/agent-hooks/SKILL.md",
    );
  });

  test("cursor user scope → ~/.cursor/skills/agent-hooks.md", () => {
    const paths = resolveSkillPaths("cursor", "user", "/repo");
    expect(paths.filePath).toContain(".cursor/skills/agent-hooks.md");
  });

  test("cursor project scope → <repo>/.cursor/skills/agent-hooks.md", () => {
    expect(resolveSkillPaths("cursor", "project", "/repo").filePath).toBe(
      "/repo/.cursor/skills/agent-hooks.md",
    );
  });

  test("codex user + project scope", () => {
    expect(resolveSkillPaths("codex", "user", "/repo").filePath).toContain(
      ".codex/skills/agent-hooks.md",
    );
    expect(resolveSkillPaths("codex", "project", "/repo").filePath).toBe(
      "/repo/.codex/skills/agent-hooks.md",
    );
  });
});

describe("installSkill / uninstallSkill", () => {
  test("installSkill writes the template to the target path", async () => {
    const fsMem = memFs();
    const result = await installSkill({
      target: "claude",
      scope: "project",
      repoCwd: "/repo",
      fs: fsMem,
      loadTemplate: () => Promise.resolve("SKILL CONTENT"),
    });
    expect(result.wrote).toBe(true);
    expect(fsMem.files.get(result.filePath)).toBe("SKILL CONTENT");
  });

  test("uninstallSkill removes an existing skill file", async () => {
    const fsMem = memFs();
    await installSkill({
      target: "claude",
      scope: "project",
      repoCwd: "/repo",
      fs: fsMem,
      loadTemplate: () => Promise.resolve("SKILL"),
    });
    const result = await uninstallSkill({
      target: "claude",
      scope: "project",
      repoCwd: "/repo",
      fs: fsMem,
      loadTemplate: () => Promise.resolve(""),
    });
    expect(result.removed).toBe(true);
    expect(fsMem.files.size).toBe(0);
  });

  test("uninstallSkill is a no-op when the file isn't installed", async () => {
    const result = await uninstallSkill({
      target: "claude",
      scope: "user",
      repoCwd: "/repo",
      fs: memFs(),
      loadTemplate: () => Promise.resolve(""),
    });
    expect(result.removed).toBe(false);
  });
});

describe("loadSkillTemplate", () => {
  test("returns the shipped template content", async () => {
    const content = await loadSkillTemplate();
    expect(content).toContain("agent-hooks skill");
    expect(content).toContain("agent-hooks run agent-edit");
  });
});

describe("defaultSkillFs", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-skill-fs-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("roundtrip mkdirRecursive + write + exists + remove", async () => {
    const target = path.join(tmp, "a", "b", "skill.md");
    await defaultSkillFs.mkdirRecursive(path.dirname(target));
    await defaultSkillFs.write(target, "hello");
    expect(await defaultSkillFs.exists(target)).toBe(true);
    await defaultSkillFs.remove(target);
    expect(await defaultSkillFs.exists(target)).toBe(false);
  });
});
