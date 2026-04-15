import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  patchPostinstall,
  POSTINSTALL_COMMAND,
  wirePostinstall,
  type PostinstallFs,
} from "../../../src/integrations/node/postinstall.ts";

describe("patchPostinstall", () => {
  test("creates the script when no postinstall exists", () => {
    const { action, scripts } = patchPostinstall({});
    expect(action).toBe("created");
    expect(scripts.postinstall).toBe(POSTINSTALL_COMMAND);
  });

  test("preserves sibling scripts when creating", () => {
    const { scripts } = patchPostinstall({
      scripts: { test: "bun test", build: "bun run build" },
    });
    expect(scripts.test).toBe("bun test");
    expect(scripts.build).toBe("bun run build");
    expect(scripts.postinstall).toBe(POSTINSTALL_COMMAND);
  });

  test("leaves the script alone when it already contains our command", () => {
    const { action, scripts } = patchPostinstall({
      scripts: { postinstall: `patch-package && ${POSTINSTALL_COMMAND}` },
    });
    expect(action).toBe("unchanged");
    expect(scripts.postinstall).toBe(`patch-package && ${POSTINSTALL_COMMAND}`);
  });

  test("appends to an existing foreign postinstall (default mode)", () => {
    const { action, scripts } = patchPostinstall({
      scripts: { postinstall: "patch-package" },
    });
    expect(action).toBe("appended");
    expect(scripts.postinstall).toBe(`patch-package && ${POSTINSTALL_COMMAND}`);
  });

  test("replaces an existing foreign postinstall when mode is replace", () => {
    const { action, scripts } = patchPostinstall(
      { scripts: { postinstall: "patch-package" } },
      "replace",
    );
    expect(action).toBe("replaced");
    expect(scripts.postinstall).toBe(POSTINSTALL_COMMAND);
  });
});

describe("wirePostinstall", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-postinstall-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function realFs(): PostinstallFs {
    return {
      async exists(p) {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      },
      read: (p) => fs.readFile(p, "utf8"),
      write: (p, contents) => fs.writeFile(p, contents, "utf8"),
    };
  }

  test("returns skipped when no package.json is present", async () => {
    const result = await wirePostinstall({ cwd: tmp, fs: realFs() });
    expect(result.action).toBe("skipped");
    expect(result.packageJsonPath.endsWith("package.json")).toBe(true);
  });

  test("creates a postinstall script in an existing package.json", async () => {
    await fs.writeFile(
      path.join(tmp, "package.json"),
      `${JSON.stringify({ name: "x", scripts: { test: "bun test" } }, null, 2)}\n`,
      "utf8",
    );
    const result = await wirePostinstall({ cwd: tmp, fs: realFs() });
    expect(result.action).toBe("created");
    const updated = JSON.parse(
      await fs.readFile(path.join(tmp, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(updated.scripts.postinstall).toBe(POSTINSTALL_COMMAND);
    expect(updated.scripts.test).toBe("bun test");
  });

  test("appends to an existing foreign postinstall script", async () => {
    await fs.writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { postinstall: "patch-package" } }, null, 2),
      "utf8",
    );
    const result = await wirePostinstall({ cwd: tmp, fs: realFs() });
    expect(result.action).toBe("appended");
    const updated = JSON.parse(
      await fs.readFile(path.join(tmp, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(updated.scripts.postinstall).toContain("patch-package");
    expect(updated.scripts.postinstall).toContain(POSTINSTALL_COMMAND);
  });

  test("preserves trailing newline when the original had one", async () => {
    const original = `${JSON.stringify({ name: "x" }, null, 2)}\n`;
    await fs.writeFile(path.join(tmp, "package.json"), original, "utf8");
    await wirePostinstall({ cwd: tmp, fs: realFs() });
    const updated = await fs.readFile(
      path.join(tmp, "package.json"),
      "utf8",
    );
    expect(updated.endsWith("\n")).toBe(true);
  });

  test("omits trailing newline when the original had none", async () => {
    const original = JSON.stringify({ name: "x" }, null, 2);
    await fs.writeFile(path.join(tmp, "package.json"), original, "utf8");
    await wirePostinstall({ cwd: tmp, fs: realFs() });
    const updated = await fs.readFile(
      path.join(tmp, "package.json"),
      "utf8",
    );
    expect(updated.endsWith("\n")).toBe(false);
  });

  test("does not rewrite the file when unchanged", async () => {
    const payload = `${JSON.stringify(
      {
        name: "x",
        scripts: { postinstall: `echo hi && ${POSTINSTALL_COMMAND}` },
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(path.join(tmp, "package.json"), payload, "utf8");
    const statBefore = await fs.stat(path.join(tmp, "package.json"));
    // Tick so mtime has a chance to advance if we wrote.
    await new Promise((r) => setTimeout(r, 10));
    const result = await wirePostinstall({ cwd: tmp, fs: realFs() });
    const statAfter = await fs.stat(path.join(tmp, "package.json"));
    expect(result.action).toBe("unchanged");
    expect(statBefore.mtimeMs).toBe(statAfter.mtimeMs);
  });

  test("replace mode overwrites an existing foreign script", async () => {
    await fs.writeFile(
      path.join(tmp, "package.json"),
      JSON.stringify({ scripts: { postinstall: "patch-package" } }, null, 2),
      "utf8",
    );
    const result = await wirePostinstall({
      cwd: tmp,
      fs: realFs(),
      mode: "replace",
    });
    expect(result.action).toBe("replaced");
    const updated = JSON.parse(
      await fs.readFile(path.join(tmp, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(updated.scripts.postinstall).toBe(POSTINSTALL_COMMAND);
  });
});
