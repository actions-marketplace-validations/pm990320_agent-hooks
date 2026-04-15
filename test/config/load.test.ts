import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZodError } from "zod";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";
import {
  CONFIG_CANDIDATES,
  LOCAL_OVERRIDES,
  formatZodError,
  loadConfig,
  parseConfigText,
  type LoaderFs,
} from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";

/**
 * In-memory LoaderFs so tests are deterministic and fast — no tmpdirs.
 */
function memFs(files: Record<string, string>): LoaderFs {
  return {
    exists(filePath) {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(files, filePath),
      );
    },
    read(filePath) {
      const content = files[filePath];
      if (content === undefined) {
        return Promise.reject(new Error(`ENOENT: ${filePath}`));
      }
      return Promise.resolve(content);
    },
  };
}

describe("parseConfigText", () => {
  test("parses YAML for .yml", () => {
    const result = parseConfigText("name: hello", "/r/.config/agent-hooks.yml");
    expect(result).toEqual({ name: "hello" });
  });

  test("parses YAML for .yaml", () => {
    const result = parseConfigText(
      "name: yeah",
      "/r/.config/agent-hooks.yaml",
    );
    expect(result).toEqual({ name: "yeah" });
  });

  test("parses JSON5 for .json5 with comments and trailing commas", () => {
    const result = parseConfigText(
      `{ /* comment */ name: 'hello', }`,
      "/r/agent-hooks.json5",
    );
    expect(result).toEqual({ name: "hello" });
  });

  test("parses JSON for .json", () => {
    const result = parseConfigText(`{"name":"hi"}`, "/r/agent-hooks.json");
    expect(result).toEqual({ name: "hi" });
  });

  test("throws ConfigError with the underlying message for bad YAML", () => {
    expect(() =>
      parseConfigText(
        "name: :\n  - oops: [",
        "/r/.config/agent-hooks.yml",
      ),
    ).toThrow(ConfigError);
  });

  test("ConfigError from parseConfigText carries the file path and details", () => {
    try {
      parseConfigText("not json", "/r/agent-hooks.json");
      throw new Error("expected parseConfigText to throw");
    } catch (err) {
      expect(err instanceof ConfigError).toBe(true);
      expect((err as ConfigError).path).toBe("/r/agent-hooks.json");
      expect((err as ConfigError).details).not.toBeNull();
    }
  });
});

describe("formatZodError", () => {
  test("joins issues one per line with dotted paths", () => {
    const result = ConfigSchema.safeParse({ nope: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain("- ");
    }
  });

  test("marks the root when path is empty", () => {
    const err = new ZodError([
      {
        code: "custom",
        path: [],
        message: "root issue",
        input: undefined,
      },
    ]);
    expect(formatZodError(err)).toContain("(root): root issue");
  });
});

describe("loadConfig", () => {
  test("loads a minimal YAML config from .config/agent-hooks.yml", async () => {
    const fs = memFs({
      "/repo/.config/agent-hooks.yml": `name: my-app\nsteps:\n  lint:\n    run: eslint\n`,
    });
    const loaded = await loadConfig({ cwd: "/repo", fs });
    expect(loaded.config.name).toBe("my-app");
    expect(loaded.sourcePath).toBe("/repo/.config/agent-hooks.yml");
    expect(loaded.localPath).toBeNull();
  });

  test("prefers the first candidate in search order", async () => {
    const fs = memFs({
      "/repo/.config/agent-hooks.yml": `name: first`,
      "/repo/agent-hooks.yml": `name: second`,
    });
    const loaded = await loadConfig({ cwd: "/repo", fs });
    expect(loaded.config.name).toBe("first");
  });

  test("falls through to root-level agent-hooks.yml", async () => {
    const fs = memFs({
      "/repo/agent-hooks.yml": `name: root-level`,
    });
    const loaded = await loadConfig({ cwd: "/repo", fs });
    expect(loaded.sourcePath).toBe("/repo/agent-hooks.yml");
  });

  test("merges a local override file on top of the base", async () => {
    const fs = memFs({
      "/repo/.config/agent-hooks.yml": `name: base\nsteps:\n  lint:\n    run: eslint\n`,
      "/repo/.config/agent-hooks.local.yml": `name: override`,
    });
    const loaded = await loadConfig({ cwd: "/repo", fs });
    expect(loaded.config.name).toBe("override");
    expect(loaded.localPath).toBe("/repo/.config/agent-hooks.local.yml");
  });

  test("throws ConfigNotFoundError when nothing matches", async () => {
    const fs = memFs({});
    await expect(loadConfig({ cwd: "/repo", fs })).rejects.toThrow(
      ConfigNotFoundError,
    );
  });

  test("throws ConfigError with details when the schema rejects the config", async () => {
    const fs = memFs({
      "/repo/.config/agent-hooks.yml": `steps:\n  lint:\n    run: ""\n`,
    });
    try {
      await loadConfig({ cwd: "/repo", fs });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err instanceof ConfigError).toBe(true);
      const e = err as ConfigError;
      expect(e.path).toBe("/repo/.config/agent-hooks.yml");
      expect(e.details).not.toBeNull();
    }
  });

  test("honors an explicit configPath override", async () => {
    const fs = memFs({
      "/repo/custom/my-config.yaml": `name: custom`,
    });
    const loaded = await loadConfig({
      cwd: "/repo",
      configPath: "custom/my-config.yaml",
      fs,
    });
    expect(loaded.sourcePath).toBe("/repo/custom/my-config.yaml");
    expect(loaded.config.name).toBe("custom");
  });

  test("throws ConfigError when explicit configPath does not exist", async () => {
    // Explicit configPath bypasses the candidate search, so this hits the
    // "explicit path missing" guard path.
    const missingFs: LoaderFs = {
      exists() {
        return Promise.resolve(false);
      },
      read() {
        return Promise.reject(new Error("unreachable"));
      },
    };
    await expect(
      loadConfig({
        cwd: "/repo",
        configPath: "missing.yml",
        fs: missingFs,
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe("loadConfig — default filesystem", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hooks-load-"));
    await fs.mkdir(path.join(tmp, ".config"), { recursive: true });
    await fs.writeFile(
      path.join(tmp, ".config", "agent-hooks.yml"),
      "name: from-disk\n",
      "utf8",
    );
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("loads from a real directory using Bun.file", async () => {
    const loaded = await loadConfig({ cwd: tmp });
    expect(loaded.config.name).toBe("from-disk");
    expect(loaded.sourcePath).toBe(
      path.join(tmp, ".config", "agent-hooks.yml"),
    );
  });

  test("returns ConfigNotFoundError for a real empty dir", async () => {
    const empty = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-empty-"),
    );
    try {
      await expect(loadConfig({ cwd: empty })).rejects.toThrow(
        ConfigNotFoundError,
      );
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe("CONFIG_CANDIDATES and LOCAL_OVERRIDES", () => {
  test("candidates cover the documented search priority", () => {
    expect(CONFIG_CANDIDATES[0]).toBe(".config/agent-hooks.yml");
    expect(CONFIG_CANDIDATES).toContain("agent-hooks.json5");
  });

  test("local overrides mirror the main candidates", () => {
    expect(LOCAL_OVERRIDES[0]).toBe(".config/agent-hooks.local.yml");
  });
});
