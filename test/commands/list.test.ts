import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  registerListCommand,
  runListCommand,
  type ListCommandDeps,
} from "../../src/commands/list.ts";
import {
  ConfigError,
  ConfigNotFoundError,
} from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";

function fakeDeps(overrides: Partial<ListCommandDeps> = {}): {
  deps: ListCommandDeps;
  out: () => string;
  err: () => string;
} {
  let o = "";
  let e = "";
  const deps: ListCommandDeps = {
    cwd: "/repo",
    write: (t) => {
      o += t;
    },
    writeErr: (t) => {
      e += t;
    },
    load: () =>
      Promise.reject(new Error("load not stubbed")),
    ...overrides,
  };
  return { deps, out: () => o, err: () => e };
}

function loadedFixture(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      name: "my-project",
      steps: {
        lint: {
          run: "eslint {files}",
          files: "**/*.ts",
          tags: ["fast", "lint"],
          description: "ESLint over changed files",
          fix: "eslint --fix {files}",
        },
        test: {
          run: "vitest run",
          invocation: "project",
          tags: ["test"],
        },
      },
      pipelines: {
        ci: {
          steps: ["lint", "test"],
          description: "Canonical CI pipeline",
          "exclude-tags": ["slow"],
        },
        "agent-edit": {
          steps: ["lint"],
          parallel: true,
        },
      },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

describe("runListCommand", () => {
  test("prints steps and pipelines with descriptions, tags, and fix marker", async () => {
    const { deps, out } = fakeDeps({
      load: () => Promise.resolve(loadedFixture()),
    });
    const code = await runListCommand(deps);
    expect(code).toBe(0);
    const text = out();
    expect(text).toContain("project: my-project");
    expect(text).toContain("steps (2):");
    expect(text).toContain("lint");
    expect(text).toContain("ESLint over changed files");
    expect(text).toContain("[fast, lint]");
    expect(text).toContain("(has --fix)");
    expect(text).toContain("test");
    expect(text).toContain("pipelines (2):");
    expect(text).toContain("ci");
    expect(text).toContain("Canonical CI pipeline");
    expect(text).toContain("2 steps");
    expect(text).toContain("excludes [slow]");
    expect(text).toContain("parallel");
  });

  test("handles an empty config cleanly", async () => {
    const empty: LoadedConfig = {
      config: ConfigSchema.parse({}),
      sourcePath: "/repo/.config/agent-hooks.yml",
      localPath: null,
    };
    const { deps, out } = fakeDeps({
      load: () => Promise.resolve(empty),
    });
    const code = await runListCommand(deps);
    expect(code).toBe(0);
    expect(out()).toContain("steps (0)");
    expect(out()).toContain("(none defined)");
    expect(out()).toContain("pipelines (0)");
  });

  test("surfaces single-step pluralization", async () => {
    const cfg: LoadedConfig = {
      config: ConfigSchema.parse({
        steps: { lint: { run: "echo" } },
        pipelines: { quick: { steps: ["lint"] } },
      }),
      sourcePath: "/repo/.config/agent-hooks.yml",
      localPath: null,
    };
    const { deps, out } = fakeDeps({
      load: () => Promise.resolve(cfg),
    });
    await runListCommand(deps);
    expect(out()).toContain("— 1 step");
    expect(out()).not.toContain("1 steps");
  });

  test("surfaces include-tags when set", async () => {
    const cfg: LoadedConfig = {
      config: ConfigSchema.parse({
        steps: { lint: { run: "echo", tags: ["fast"] } },
        pipelines: {
          quick: { steps: ["lint"], "include-tags": ["fast"] },
        },
      }),
      sourcePath: "/repo/.config/agent-hooks.yml",
      localPath: null,
    };
    const { deps, out } = fakeDeps({
      load: () => Promise.resolve(cfg),
    });
    await runListCommand(deps);
    expect(out()).toContain("includes [fast]");
  });

  test("returns 2 and writes to stderr when config is not found", async () => {
    const { deps, err } = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
    });
    const code = await runListCommand(deps);
    expect(code).toBe(2);
    expect(err()).toContain("/repo");
  });

  test("returns 2 and prints details on ConfigError", async () => {
    const { deps, err } = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigError("Invalid config", {
            path: "/repo/.config/agent-hooks.yml",
            details: "bad",
          }),
        ),
    });
    const code = await runListCommand(deps);
    expect(code).toBe(2);
    expect(err()).toContain("Invalid config");
    expect(err()).toContain("bad");
  });

  test("handles ConfigError without details", async () => {
    const { deps, err } = fakeDeps({
      load: () => Promise.reject(new ConfigError("bad")),
    });
    expect(await runListCommand(deps)).toBe(2);
    expect(err()).toContain("bad");
  });

  test("propagates unexpected load errors", async () => {
    const { deps } = fakeDeps({
      load: () => Promise.reject(new TypeError("boom")),
    });
    await expect(runListCommand(deps)).rejects.toThrow(TypeError);
  });
});

describe("registerListCommand", () => {
  test("wires the `list` subcommand and throws ExitError on config failure", async () => {
    const program = new Command().exitOverride();
    registerListCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
    });
    try {
      await program.parseAsync(["list"], { from: "user" });
      throw new Error("expected ExitError");
    } catch (caught) {
      expect(caught instanceof ExitError).toBe(true);
      expect((caught as ExitError).exitCode).toBe(2);
    }
  });

  test("runs successfully end-to-end via commander", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerListCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(loadedFixture()),
    });
    await program.parseAsync(["list"], { from: "user" });
    expect(out).toContain("steps");
    expect(out).toContain("pipelines");
  });

  test("falls back to process wiring when overrides are omitted", () => {
    const program = new Command().exitOverride();
    registerListCommand(program);
    expect(program.commands.find((c) => c.name() === "list")).toBeDefined();
  });
});
