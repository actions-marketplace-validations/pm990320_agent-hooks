import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  cmd: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const proc = Bun.spawn([...cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("packaged CLI regression", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot !== null) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  test("npm package includes the shipped agent-hooks skill template", async () => {
    const result = await runCommand(
      ["npm", "pack", "--dry-run", "--json"],
      REPO_ROOT,
    );
    expect(result.exitCode).toBe(0);
    const [pack] = JSON.parse(result.stdout) as {
      readonly files: { readonly path: string }[];
    }[];
    const filePaths = new Set(pack?.files.map((file) => file.path) ?? []);
    expect(filePaths.has("templates/skills/agent-hooks.skill.md")).toBe(true);
  });

  test("built node dist can install the skill from an npm-style package layout", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-package-"));
    const packageRoot = path.join(tempRoot, "package");
    const projectRoot = path.join(tempRoot, "project");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.cp(
      path.join(REPO_ROOT, "templates"),
      path.join(packageRoot, "templates"),
      { recursive: true },
    );

    const buildResult = await runCommand(
      [
        "bun",
        "build",
        path.join(REPO_ROOT, "src", "index.ts"),
        "--target=node",
        "--outdir",
        path.join(packageRoot, "dist"),
        "--minify",
      ],
      REPO_ROOT,
    );
    expect(buildResult.exitCode).toBe(0);

    const distEntry = path.join(packageRoot, "dist", "index.js");
    const bundled = await fs.readFile(distEntry, "utf8");
    await fs.writeFile(
      distEntry,
      bundled.replace("#!/usr/bin/env bun", "#!/usr/bin/env node"),
      "utf8",
    );

    const installResult = await runCommand(
      ["node", distEntry, "agent", "skill", "install", "claude", "--project"],
      projectRoot,
    );
    expect(installResult.exitCode).toBe(0);
    expect(installResult.stderr).toBe("");
    expect(installResult.stdout).toContain("installed skill");

    const skillPath = path.join(
      projectRoot,
      ".claude",
      "skills",
      "agent-hooks",
      "SKILL.md",
    );
    const skill = await fs.readFile(skillPath, "utf8");
    expect(skill).toContain("agent-hooks skill");
    expect(skill).toContain("agent-hooks run agent-edit");
  });
});
