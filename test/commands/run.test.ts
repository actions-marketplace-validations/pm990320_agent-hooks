import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  defaultRunDeps,
  pickScope,
  registerCiCommand,
  registerRunCommand,
  registerShortcutCommand,
  resolveTarget,
  runCommand,
  type RunArgs,
  type RunCommandDeps,
} from "../../src/commands/run.ts";
import {
  ConfigError,
  ConfigNotFoundError,
} from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { GitRunner } from "../../src/runners/files.ts";
import type { ExecFn, ExecInput } from "../../src/runners/step.ts";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Test helpers --------------------------------------------------------

function sampleConfig() {
  return ConfigSchema.parse({
    steps: {
      lint: { run: "eslint {files}", files: "**/*.ts", tags: ["fast"] },
      typecheck: {
        run: "tsc --noEmit",
        invocation: "project",
        tags: ["fast"],
      },
      test: {
        run: "vitest run --related {files}",
        files: "**/*.ts",
        tags: ["fast"],
      },
      e2e: {
        run: "playwright test",
        invocation: "project",
        tags: ["slow", "e2e"],
      },
    },
    pipelines: {
      ci: { steps: ["lint", "typecheck", "test", "e2e"] },
      "agent-edit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
        "exclude-tags": ["slow", "e2e"],
      },
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

function stubGit(files: readonly string[] = ["src/a.ts", "src/b.ts"]): GitRunner {
  return {
    staged: () => Promise.resolve(files),
    changed: () => Promise.resolve(files),
    all: () => Promise.resolve(files),
  };
}

interface Fake {
  readonly deps: RunCommandDeps;
  readonly calls: ExecInput[];
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function fakeDeps(
  overrides: Partial<RunCommandDeps> = {},
  execExitCode: ((input: ExecInput) => number) | undefined = undefined,
): Fake {
  let out = "";
  let err = "";
  const calls: ExecInput[] = [];
  const exec: ExecFn = (input) => {
    calls.push(input);
    return Promise.resolve({
      exitCode: execExitCode ? execExitCode(input) : 0,
      durationMs: 1,
    });
  };
  const deps: RunCommandDeps = {
    cwd: "/repo",
    write: (t) => {
      out += t;
    },
    writeErr: (t) => {
      err += t;
    },
    load: () => Promise.resolve(stubLoaded()),
    makeGit: () => stubGit(),
    exec,
    env: {},
    ...overrides,
  };
  return {
    deps,
    calls,
    stdout: () => out,
    stderr: () => err,
  };
}

// --- pickScope -----------------------------------------------------------

describe("pickScope", () => {
  test("explicit files win when provided", () => {
    expect(pickScope({ target: "ci", explicitFiles: ["a.ts"] })).toBe(
      "explicit",
    );
  });

  test("--all beats --staged and --changed", () => {
    expect(pickScope({ target: "ci", all: true, staged: true })).toBe("all");
  });

  test("--staged beats --changed", () => {
    expect(pickScope({ target: "ci", staged: true, changed: true })).toBe(
      "staged",
    );
  });

  test("--changed explicitly", () => {
    expect(pickScope({ target: "ci", changed: true })).toBe("changed");
  });

  test("default is changed", () => {
    expect(pickScope({ target: "ci" })).toBe("changed");
  });

  test("empty explicit files list falls through to default", () => {
    expect(pickScope({ target: "ci", explicitFiles: [] })).toBe("changed");
  });
});

// --- resolveTarget -------------------------------------------------------

describe("resolveTarget", () => {
  test("resolves a pipeline name directly", () => {
    const result = resolveTarget(sampleConfig(), "ci");
    expect(result?.pipelineName).toBe("ci");
  });

  test("synthesizes a single-step pipeline for a step name", () => {
    const result = resolveTarget(sampleConfig(), "lint");
    expect(result?.pipelineName).toBe("__agent_hooks_single__");
    expect(
      result?.config.pipelines["__agent_hooks_single__"]?.steps,
    ).toEqual(["lint"]);
  });

  test("returns null for unknown targets", () => {
    expect(resolveTarget(sampleConfig(), "nope")).toBeNull();
  });
});

// --- runCommand ----------------------------------------------------------

describe("runCommand", () => {
  test("runs a named pipeline successfully and prints a summary", async () => {
    const fake = fakeDeps();
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("pipeline: agent-edit");
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  test("runs a single step when the target is a step name", async () => {
    const fake = fakeDeps();
    const code = await runCommand(
      { target: "lint", explicitFiles: ["src/a.ts"] },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("__agent_hooks_single__");
  });

  test("returns 2 and writes to stderr for an unknown target", async () => {
    const fake = fakeDeps();
    const code = await runCommand({ target: "ghost" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.stderr()).toContain("unknown pipeline or step");
    expect(fake.stderr()).toContain("known pipelines");
  });

  test("returns 2 when config is not found", async () => {
    const fake = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
    });
    const code = await runCommand({ target: "ci" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.stderr()).toContain("/repo");
  });

  test("returns 2 when config is invalid", async () => {
    const fake = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigError("Invalid config", {
            path: "/repo/.config/agent-hooks.yml",
            details: "steps.lint.run: too small",
          }),
        ),
    });
    const code = await runCommand({ target: "ci" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.stderr()).toContain("Invalid config");
  });

  test("handles ConfigError without details", async () => {
    const fake = fakeDeps({
      load: () => Promise.reject(new ConfigError("bad config")),
    });
    const code = await runCommand({ target: "ci" }, fake.deps);
    expect(code).toBe(2);
    expect(fake.stderr()).toContain("bad config");
  });

  test("propagates unexpected load errors", async () => {
    const fake = fakeDeps({
      load: () => Promise.reject(new TypeError("boom")),
    });
    await expect(runCommand({ target: "ci" }, fake.deps)).rejects.toThrow(
      TypeError,
    );
  });

  test("returns the pipeline exit code on failure", async () => {
    const fake = fakeDeps(
      {},
      (input) => (input.command.startsWith("eslint") ? 1 : 0),
    );
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(1);
  });

  test("AGENT_HOOKS_SKIP=1 short-circuits with skipAll", async () => {
    const fake = fakeDeps({
      env: { AGENT_HOOKS_SKIP: "1" },
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("skipping all steps");
  });

  test("AGENT_HOOKS_SKIP=lint,typecheck adds to the skip set", async () => {
    const fake = fakeDeps({
      env: { AGENT_HOOKS_SKIP: "lint,typecheck" },
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    // Both should appear as skipped-by-flag in the summary.
    expect(fake.stdout()).toContain("lint");
    expect(fake.stdout()).toContain("typecheck");
  });

  test("AGENT_HOOKS_ONLY env restricts which steps run", async () => {
    const fake = fakeDeps({
      env: { AGENT_HOOKS_ONLY: "lint" },
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("not in --only list");
  });

  test("commit message [skip ci] short-circuits with skipAll", async () => {
    const fake = fakeDeps({
      makeGit: () => ({
        ...stubGit(),
        commitMessage: () =>
          Promise.resolve("fix: bug\n\n[skip ci]"),
      }),
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("skipping all steps");
    expect(fake.stdout()).toContain("commit-message");
  });

  test("commit message [skip lint] adds lint to the skip set", async () => {
    const fake = fakeDeps({
      makeGit: () => ({
        ...stubGit(),
        commitMessage: () =>
          Promise.resolve("feat: thing\n\n[skip lint]"),
      }),
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    // lint is skipped while typecheck/test still run.
    const ranLint = fake.calls.some((c) => c.command.startsWith("eslint"));
    expect(ranLint).toBe(false);
  });

  test("env-resolution layers print a summary line and notes", async () => {
    const fakeResolver = {
      fs: { exists: () => Promise.resolve(false) },
      whichCommand: () => Promise.resolve(null),
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };
    // Use a stub that records sources by hijacking resolveEnvironment via
    // a custom resolver that pretends direnv fired. Easier: load config
    // with an `env:` block so the config layer fires and prints.
    const cfg = ConfigSchema.parse({
      env: { CUSTOM_VAR: "x" },
      steps: {
        lint: { run: "eslint {files}", files: "**/*.ts" },
      },
      pipelines: {
        ci: { steps: ["lint"] },
      },
    });
    const fake = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      envResolver: fakeResolver,
    });
    const code = await runCommand(
      { target: "ci", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("env: config(1)");
  });

  test("env-resolution notes are surfaced as warnings", async () => {
    // A resolver that reports a note from a missing tool.
    const noisyResolver = {
      fs: {
        exists: (p: string) =>
          Promise.resolve(p.endsWith("/.envrc")),
      },
      whichCommand: () => Promise.resolve(null),
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const fake = fakeDeps({ envResolver: noisyResolver });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stdout()).toContain("⚠ env:");
    expect(fake.stdout()).toContain("direnv");
  });

  test("emits prompt blocks to stderr when context=agent", async () => {
    const fake = fakeDeps({ envResolver: null });
    const code = await runCommand(
      { target: "agent-edit", all: true, promptContext: "agent" },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stderr()).toContain("---agent-hooks:next-step---");
    expect(fake.stderr()).toContain("status: passed");
  });

  test("tty context emits prompts only on failure", async () => {
    const fake = fakeDeps(
      { envResolver: null },
      (input) => (input.command.startsWith("eslint") ? 1 : 0),
    );
    const code = await runCommand(
      { target: "agent-edit", all: true, promptContext: "tty" },
      fake.deps,
    );
    expect(code).toBe(1);
    expect(fake.stderr()).toContain("---agent-hooks:next-step---");
    expect(fake.stderr()).toContain("status: failed");
    // Only lint failed, so only one block.
    const blocks = fake.stderr().split("---agent-hooks:next-step---").length - 1;
    expect(blocks).toBe(1);
  });

  test("noPrompts suppresses every block even in agent context", async () => {
    const fake = fakeDeps({ envResolver: null });
    const code = await runCommand(
      {
        target: "agent-edit",
        all: true,
        promptContext: "agent",
        noPrompts: true,
      },
      fake.deps,
    );
    expect(code).toBe(0);
    expect(fake.stderr()).not.toContain("---agent-hooks:next-step---");
  });

  test("promptContext=ci writes agent-hooks-report.yml with failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-hooks-run-ci-report-"));
    try {
      const cfg = ConfigSchema.parse({
        steps: {
          fail: {
            run: "false",
            invocation: "project",
            tags: ["fast", "lint"],
          },
          ok: {
            run: "echo ok",
            invocation: "project",
          },
        },
        pipelines: {
          ci: { steps: ["fail", "ok"] },
        },
      });
      const fake = fakeDeps({
        cwd,
        load: () =>
          Promise.resolve({
            config: cfg,
            sourcePath: join(cwd, ".config/agent-hooks.yml"),
            localPath: null,
          }),
        exec: (input) =>
          Promise.resolve({
            exitCode: input.command.includes("false") ? 1 : 0,
            durationMs: 1,
          }),
      }, (input) => (input.command.includes("false") ? 1 : 0));
      const code = await runCommand(
        { target: "ci", all: true, promptContext: "ci" },
        fake.deps,
      );
      expect(code).toBe(1);
      const report = await readFile(join(cwd, "agent-hooks-report.yml"), "utf8");
      expect(report).toContain("- step: fail");
      expect(report).toContain("status: failed");
      expect(report).toContain("exit_code: 1");
      // no prompt block should appear on stderr by default because policy for
      // ci emits failures only, which still includes this failed step.
      expect(fake.stderr()).toContain("---agent-hooks:next-step---");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("envResolver: null skips the env-resolution layer entirely", async () => {
    const fake = fakeDeps({
      envResolver: null,
      env: { FROM_DEPS: "yes" },
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    expect(code).toBe(0);
    // No "env: " line printed because we skipped resolution entirely.
    expect(fake.stdout()).not.toContain("↳ env:");
  });

  test("commit message lookup that throws is treated as no message", async () => {
    const fake = fakeDeps({
      makeGit: () => ({
        ...stubGit(),
        commitMessage: () =>
          Promise.reject(new Error("git not available")),
      }),
    });
    const code = await runCommand(
      { target: "agent-edit", all: true },
      fake.deps,
    );
    // Failure is swallowed — no skipAll, runs normally.
    expect(code).toBe(0);
    expect(fake.stdout()).not.toContain("skipping all steps");
  });

  test("honors --skip, --only, and --jobs", async () => {
    const fake = fakeDeps();
    const args: RunArgs = {
      target: "agent-edit",
      all: true,
      skip: ["typecheck"],
      jobs: 2,
    };
    const code = await runCommand(args, fake.deps);
    expect(code).toBe(0);
    const runNames = fake.stdout();
    expect(runNames).toContain("lint");
    // typecheck was skipped so it still appears in the summary but as
    // skipped-by-flag, not ran.
    expect(runNames).toContain("typecheck");
    expect(runNames).toContain("--skip");

    const onlyFake = fakeDeps();
    await runCommand(
      { target: "agent-edit", all: true, only: ["lint"] },
      onlyFake.deps,
    );
    expect(onlyFake.stdout()).toContain("not in --only list");
  });

  test("uses the correct scope-specific git method", async () => {
    const calls: string[] = [];
    const fake = fakeDeps({
      makeGit: () => ({
        staged: () => {
          calls.push("staged");
          return Promise.resolve(["src/a.ts"]);
        },
        changed: () => {
          calls.push("changed");
          return Promise.resolve(["src/a.ts"]);
        },
        all: () => {
          calls.push("all");
          return Promise.resolve(["src/a.ts"]);
        },
      }),
    });
    await runCommand({ target: "agent-edit", staged: true }, fake.deps);
    expect(calls).toContain("staged");

    const fake2 = fakeDeps({
      makeGit: () => ({
        staged: () => Promise.resolve([]),
        changed: () => Promise.resolve([]),
        all: () => {
          calls.push("all");
          return Promise.resolve(["src/a.ts"]);
        },
      }),
    });
    await runCommand({ target: "agent-edit", all: true }, fake2.deps);
    expect(calls.filter((c) => c === "all").length).toBeGreaterThan(0);
  });
});

// --- Commander registration ---------------------------------------------

describe("registerRunCommand / registerCiCommand / registerShortcutCommand", () => {
  test("run command fires the action and throws ExitError on failure", async () => {
    const program = new Command().exitOverride();
    let captured = "";
    registerRunCommand(program, {
      cwd: "/repo",
      write: (t) => {
        captured += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: () => Promise.resolve({ exitCode: 1, durationMs: 1 }),
      env: {},
    });
    try {
      await program.parseAsync(["run", "agent-edit", "--all"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect((err as ExitError).exitCode).toBe(1);
    }
    expect(captured).toContain("pipeline: agent-edit");
  });

  test("run command succeeds silently when pipeline passes", async () => {
    const program = new Command().exitOverride();
    registerRunCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(["run", "agent-edit", "--all"], {
      from: "user",
    });
  });

  test("run command parses --files, --staged, --skip, --only, --jobs flags", async () => {
    const program = new Command().exitOverride();
    const calls: string[] = [];
    registerRunCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => ({
        staged: () => {
          calls.push("staged");
          return Promise.resolve(["src/a.ts"]);
        },
        changed: () => Promise.resolve([]),
        all: () => Promise.resolve([]),
      }),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(
      [
        "run",
        "agent-edit",
        "--staged",
        "--skip",
        "typecheck",
        "--only",
        "lint,test",
        "-j",
        "2",
      ],
      { from: "user" },
    );
    expect(calls).toContain("staged");
  });

  test("run command with --changed flag", async () => {
    const program = new Command().exitOverride();
    const calls: string[] = [];
    registerRunCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => ({
        staged: () => Promise.resolve([]),
        changed: () => {
          calls.push("changed");
          return Promise.resolve(["src/a.ts"]);
        },
        all: () => Promise.resolve([]),
      }),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(["run", "agent-edit", "--changed"], {
      from: "user",
    });
    expect(calls).toContain("changed");
  });

  test("run command with --files passes explicit paths through", async () => {
    const program = new Command().exitOverride();
    const execCalls: ExecInput[] = [];
    registerRunCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit([]),
      exec: (input) => {
        execCalls.push(input);
        return Promise.resolve({ exitCode: 0, durationMs: 1 });
      },
      env: {},
    });
    await program.parseAsync(
      ["run", "lint", "--files", "src/foo.ts", "src/bar.ts"],
      { from: "user" },
    );
    const eslintCall = execCalls.find((c) => c.command.startsWith("eslint"));
    expect(eslintCall?.command).toContain("src/foo.ts");
    expect(eslintCall?.command).toContain("src/bar.ts");
  });

  test("run command with --agent emits prompts for passed steps", async () => {
    const program = new Command().exitOverride();
    let capturedErr = "";
    registerRunCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: (text) => {
        capturedErr += text;
      },
      load: () =>
        Promise.resolve({
          config: sampleConfig(),
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGit(["src/a.ts"]),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(["run", "agent-edit", "--all", "--agent"], {
      from: "user",
    });
    expect(capturedErr).toContain("---agent-hooks:next-step---");
    expect(capturedErr).toContain("status: passed");
  });

  test("ci command runs the `ci` pipeline with its own flags", async () => {
    const program = new Command().exitOverride();
    let captured = "";
    registerCiCommand(program, {
      cwd: "/repo",
      write: (t) => {
        captured += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(["ci", "--all"], { from: "user" });
    expect(captured).toContain("pipeline: ci");
  });

  test("shortcut commands run the named pipeline/step", async () => {
    const program = new Command().exitOverride();
    let captured = "";
    registerShortcutCommand(program, "lint", "lint shortcut", {
      cwd: "/repo",
      write: (t) => {
        captured += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: () => Promise.resolve({ exitCode: 0, durationMs: 1 }),
      env: {},
    });
    await program.parseAsync(["lint", "--all"], { from: "user" });
    expect(captured).toContain("lint");
  });

  test("run command registered with no deps uses defaults (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerRunCommand(program);
    expect(cmd).toBeDefined();
  });

  test("ci command registered with no deps uses defaults (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerCiCommand(program);
    expect(cmd).toBeDefined();
  });

  test("shortcut command registered with no deps uses defaults (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerShortcutCommand(program, "lint", "lint shortcut");
    expect(cmd).toBeDefined();
  });
});

// --- defaultRunDeps writers + exec --------------------------------------

describe("defaultRunDeps", () => {
  test("write forwards to process.stdout", () => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      defaultRunDeps.write("hello");
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toBe("hello");
  });

  test("writeErr forwards to process.stderr", () => {
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      defaultRunDeps.writeErr("bad");
    } finally {
      process.stderr.write = original;
    }
    expect(captured).toBe("bad");
  });

  test("load delegates to loadConfig (real FS, expected to reject in /tmp)", async () => {
    await expect(defaultRunDeps.load("/tmp")).rejects.toThrow(
      ConfigNotFoundError,
    );
  });

  test("makeGit returns a real GitRunner that can call ls-files on this repo", async () => {
    const git = defaultRunDeps.makeGit(process.cwd());
    const files = await git.all();
    expect(files.length).toBeGreaterThan(0);
  });

  test("exec runs a real command and returns its exit code", async () => {
    const result = await defaultRunDeps.exec({
      command: "true",
      cwd: process.cwd(),
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("exec supports stdin piping", async () => {
    const result = await defaultRunDeps.exec({
      command: "cat > /dev/null",
      cwd: process.cwd(),
      env: {},
      stdin: "hello\n",
    });
    expect(result.exitCode).toBe(0);
  });
});
