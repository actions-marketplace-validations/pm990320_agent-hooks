import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  defaultInstallDeps,
  registerInstallCommand,
  runInstallCommand,
} from "../../src/commands/install.ts";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { HookFs } from "../../src/integrations/git/install.ts";

function memFs(): HookFs & { files: Map<string, { contents: string; mode: number }> } {
  const files = new Map<string, { contents: string; mode: number }>();
  return {
    files,
    exists: (p) => Promise.resolve(files.has(p)),
    read: (p) => {
      const entry = files.get(p);
      if (!entry) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(entry.contents);
    },
    write: (p, contents, mode) => {
      files.set(p, { contents, mode });
      return Promise.resolve();
    },
    mkdirRecursive: () => Promise.resolve(),
    remove: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
  };
}

function stubLoaded(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "pre-commit": { steps: ["lint"] } },
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

describe("runInstallCommand", () => {
  test("writes hook stubs and prints a summary", async () => {
    const fsMem = memFs();
    let out = "";
    const code = await runInstallCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        writeErr: () => {},
        load: () => Promise.resolve(stubLoaded()),
        hookFs: fsMem,
      },
    );
    expect(code).toBe(0);
    expect(fsMem.files.has("/repo/.git/hooks/pre-commit")).toBe(true);
    expect(out).toContain("install complete");
    expect(out).toContain("wrote");
  });

  test("--if-missing is silent when everything is already current", async () => {
    const fsMem = memFs();
    // First run to prime the stubs.
    await runInstallCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        writeErr: () => {},
        load: () => Promise.resolve(stubLoaded()),
        hookFs: fsMem,
      },
    );
    // Second run with --if-missing should no-op silently.
    let out = "";
    const code = await runInstallCommand(
      { ifMissing: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        writeErr: () => {},
        load: () => Promise.resolve(stubLoaded()),
        hookFs: fsMem,
      },
    );
    expect(code).toBe(0);
    expect(out).toBe("");
  });

  test("--if-missing prints a summary when something was out-of-date", async () => {
    const fsMem = memFs();
    // Don't prime — first run counts as the --if-missing call.
    let out = "";
    const code = await runInstallCommand(
      { ifMissing: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        writeErr: () => {},
        load: () => Promise.resolve(stubLoaded()),
        hookFs: fsMem,
      },
    );
    expect(code).toBe(0);
    expect(out).toContain("install complete");
  });

  test("returns 2 on ConfigNotFoundError", async () => {
    let err = "";
    const code = await runInstallCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        writeErr: (t) => {
          err += t;
        },
        load: () =>
          Promise.reject(new ConfigNotFoundError("/repo", ["/repo/ah.yml"])),
        hookFs: memFs(),
      },
    );
    expect(code).toBe(2);
    expect(err).toContain("/repo");
  });

  test("returns 2 on ConfigError and surfaces details", async () => {
    let err = "";
    const code = await runInstallCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        writeErr: (t) => {
          err += t;
        },
        load: () =>
          Promise.reject(
            new ConfigError("Invalid", {
              path: "/repo/ah.yml",
              details: "bad",
            }),
          ),
        hookFs: memFs(),
      },
    );
    expect(code).toBe(2);
    expect(err).toContain("Invalid");
    expect(err).toContain("bad");
  });

  test("propagates unexpected load errors", async () => {
    await expect(
      runInstallCommand(
        {},
        {
          cwd: "/repo",
          write: () => {},
          writeErr: () => {},
          load: () => Promise.reject(new TypeError("boom")),
          hookFs: memFs(),
        },
      ),
    ).rejects.toThrow(TypeError);
  });
});

describe("registerInstallCommand", () => {
  test("parses --if-missing and runs to completion", async () => {
    const program = new Command().exitOverride();
    const fsMem = memFs();
    registerInstallCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      hookFs: fsMem,
    });
    await program.parseAsync(["install", "--if-missing"], {
      from: "user",
    });
    expect(fsMem.files.has("/repo/.git/hooks/pre-commit")).toBe(true);
  });

  test("throws ExitError when the command returns non-zero", async () => {
    const program = new Command().exitOverride();
    registerInstallCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(new ConfigNotFoundError("/repo", ["/repo/ah.yml"])),
      hookFs: memFs(),
    });
    try {
      await program.parseAsync(["install"], { from: "user" });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect((err as ExitError).exitCode).toBe(2);
    }
  });

  test("registers with default deps (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerInstallCommand(program);
    expect(cmd).toBeDefined();
  });
});

describe("defaultInstallDeps", () => {
  test("exposes all required slots", () => {
    expect(typeof defaultInstallDeps.write).toBe("function");
    expect(typeof defaultInstallDeps.writeErr).toBe("function");
    expect(typeof defaultInstallDeps.load).toBe("function");
    expect(defaultInstallDeps.hookFs).toBeDefined();
  });
});
