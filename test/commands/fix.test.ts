import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  buildFixConfig,
  registerFixCommand,
  runFixCommand,
  type FixCommandDeps,
} from "../../src/commands/fix.ts";
import {
  ConfigError,
  ConfigNotFoundError,
} from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { GitRunner } from "../../src/runners/files.ts";
import type { ExecFn, ExecInput } from "../../src/runners/step.ts";

function stubGit(files: readonly string[] = ["src/a.ts"]): GitRunner {
  return {
    staged: () => Promise.resolve(files),
    changed: () => Promise.resolve(files),
    all: () => Promise.resolve(files),
  };
}

function sampleConfig() {
  return ConfigSchema.parse({
    steps: {
      lint: {
        run: "eslint {files}",
        fix: "eslint --fix {files}",
        files: "**/*.ts",
      },
      test: {
        run: "vitest run",
      },
    },
    pipelines: {
      ci: { steps: ["lint", "test"] },
    },
  });
}

function stubLoaded(): LoadedConfig {
  return {
    config: sampleConfig(),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function fakeDeps(
  overrides: Partial<FixCommandDeps> = {},
): {
  deps: FixCommandDeps;
  calls: ExecInput[];
  out: () => string;
  err: () => string;
} {
  let o = "";
  let e = "";
  const calls: ExecInput[] = [];
  const exec: ExecFn = (input) => {
    calls.push(input);
    return Promise.resolve({ exitCode: 0, durationMs: 1 });
  };
  const deps: FixCommandDeps = {
    cwd: "/repo",
    write: (t) => {
      o += t;
    },
    writeErr: (t) => {
      e += t;
    },
    load: () => Promise.resolve(stubLoaded()),
    makeGit: () => stubGit(),
    exec,
    env: {},
    envResolver: null,
    ...overrides,
  };
  return { deps, calls, out: () => o, err: () => e };
}

// --- buildFixConfig ------------------------------------------------------

describe("buildFixConfig", () => {
  test("returns null when step does not exist", () => {
    expect(buildFixConfig(sampleConfig(), "nope")).toBeNull();
  });

  test("returns null when step has no fix defined", () => {
    expect(buildFixConfig(sampleConfig(), "test")).toBeNull();
  });

  test("rewrites run: to the fix command and adds a one-step pipeline", () => {
    const built = buildFixConfig(sampleConfig(), "lint");
    expect(built).not.toBeNull();
    expect(built?.pipelineName).toBe("__agent_hooks_fix__");
    const rewrittenLint = built?.config.steps.lint;
    expect(rewrittenLint?.run).toBe("eslint --fix {files}");
    expect(
      built?.config.pipelines.__agent_hooks_fix__?.steps,
    ).toEqual(["lint"]);
  });
});

// --- runFixCommand -------------------------------------------------------

describe("runFixCommand", () => {
  test("runs the fix template against staged files by default", async () => {
    const fake = fakeDeps();
    const code = await runFixCommand(
      { step: "lint", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0]?.command).toContain("eslint --fix");
  });

  test("rejects an unknown step with exit 2", async () => {
    const fake = fakeDeps();
    const code = await runFixCommand({ step: "ghost" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.err()).toContain("unknown step");
  });

  test("rejects a step without a fix command", async () => {
    const fake = fakeDeps();
    const code = await runFixCommand({ step: "test" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.err()).toContain("no fix");
  });

  test("returns 2 on ConfigNotFoundError", async () => {
    const fake = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
    });
    expect(await runFixCommand({ step: "lint" }, fake.deps)).toBe(2);
    expect(fake.err()).toContain("/repo");
  });

  test("returns 2 on ConfigError with details", async () => {
    const fake = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigError("Invalid", {
            path: "/repo/.config/agent-hooks.yml",
            details: "broken",
          }),
        ),
    });
    expect(await runFixCommand({ step: "lint" }, fake.deps)).toBe(2);
    expect(fake.err()).toContain("Invalid");
    expect(fake.err()).toContain("broken");
  });

  test("returns 2 on ConfigError without details", async () => {
    const fake = fakeDeps({
      load: () => Promise.reject(new ConfigError("bad")),
    });
    expect(await runFixCommand({ step: "lint" }, fake.deps)).toBe(2);
  });

  test("propagates unexpected load errors", async () => {
    const fake = fakeDeps({
      load: () => Promise.reject(new TypeError("boom")),
    });
    await expect(
      runFixCommand({ step: "lint" }, fake.deps),
    ).rejects.toThrow(TypeError);
  });

  test("honors --files explicit scope", async () => {
    const fake = fakeDeps();
    await runFixCommand(
      { step: "lint", explicitFiles: ["src/a.ts"] },
      fake.deps,
    );
    expect(fake.calls[0]?.command).toContain("src/a.ts");
  });

  test("honors --staged and --changed flags", async () => {
    const a = fakeDeps();
    await runFixCommand({ step: "lint", staged: true }, a.deps);
    expect(a.calls.length).toBeGreaterThan(0);

    const b = fakeDeps();
    await runFixCommand({ step: "lint", changed: true }, b.deps);
    expect(b.calls.length).toBeGreaterThan(0);
  });
});

// --- registerFixCommand --------------------------------------------------

describe("registerFixCommand", () => {
  test("registers a `fix` subcommand and runs it end-to-end", async () => {
    const program = new Command().exitOverride();
    let out = "";
    const calls: ExecInput[] = [];
    registerFixCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: (input) => {
        calls.push(input);
        return Promise.resolve({ exitCode: 0, durationMs: 1 });
      },
      env: {},
      envResolver: null,
    });
    await program.parseAsync(["fix", "lint", "--all"], { from: "user" });
    expect(out).toContain("__agent_hooks_fix__");
    expect(calls[0]?.command).toContain("eslint --fix");
  });

  test("throws ExitError on an unknown step", async () => {
    const program = new Command().exitOverride();
    registerFixCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
      envResolver: null,
    });
    try {
      await program.parseAsync(["fix", "nope"], { from: "user" });
      throw new Error("expected ExitError");
    } catch (caught) {
      expect(caught instanceof ExitError).toBe(true);
      expect((caught as ExitError).exitCode).toBe(2);
    }
  });

  test("default wiring registers the subcommand with no overrides", () => {
    const program = new Command().exitOverride();
    registerFixCommand(program);
    expect(program.commands.find((c) => c.name() === "fix")).toBeDefined();
  });
});
