import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  defaultDoctorDeps,
  registerDoctorCommand,
  runDoctor,
  type DoctorDeps,
} from "../../src/commands/doctor.ts";
import type { AgentHandler } from "../../src/hooks/types.ts";
import {
  ConfigError,
  ConfigNotFoundError,
} from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import { type HookFs } from "../../src/integrations/git/install.ts";
import { buildStub } from "../../src/integrations/git/stub.ts";
import { configHash } from "../../src/integrations/git/hash.ts";
import type { GitRunner } from "../../src/runners/files.ts";

function fakeDeps(partial: Partial<DoctorDeps>): {
  deps: DoctorDeps;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  const deps: DoctorDeps = {
    cwd: "/repo",
    write: (t) => {
      out += t;
    },
    writeErr: (t) => {
      err += t;
    },
    load: () =>
      Promise.reject(new Error("load() not stubbed in this test")),
    ...partial,
  };
  return {
    deps,
    stdout: () => out,
    stderr: () => err,
  };
}

function loaded(
  overrides: Partial<LoadedConfig> = {},
): () => Promise<LoadedConfig> {
  const base: LoadedConfig = {
    config: ConfigSchema.parse({
      steps: { lint: { run: "eslint {files}" } },
      pipelines: { ci: { steps: ["lint"] } },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
    ...overrides,
  };
  return () => Promise.resolve(base);
}

interface MemHookEntry {
  readonly contents: string;
  readonly mode: number;
}

function memHookFs(): HookFs & { files: Map<string, MemHookEntry> } {
  const files = new Map<string, MemHookEntry>();
  return {
    files,
    exists(p) {
      return Promise.resolve(files.has(p));
    },
    read(p) {
      const entry = files.get(p);
      if (!entry) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(entry.contents);
    },
    write(p, contents, mode) {
      files.set(p, { contents, mode });
      return Promise.resolve();
    },
    mkdirRecursive(_p) {
      return Promise.resolve();
    },
    remove(_p) {
      return Promise.resolve();
    },
  };
}

function stubGitRoot(root: string | null): GitRunner {
  return {
    staged() {
      return Promise.resolve([]);
    },
    changed() {
      return Promise.resolve([]);
    },
    all() {
      return Promise.resolve([]);
    },
    gitRoot() {
      return Promise.resolve(root);
    },
  };
}

function fakeAgentHandlers(present = false): readonly AgentHandler[] {
  return [
    {
      name: "alpha",
      displayName: "Alpha",
      hookEvents: ["commit", "push"],
      parseInput() {
        return {
          toolName: null,
          files: [],
          hookEventName: null,
        };
      },
      detect(_cwd, homeDir) {
        if (!present) {
          return Promise.resolve({ present: false });
        }
        return Promise.resolve({
          present: true,
          scope: "user",
          path: `${homeDir}/.alpha/settings.json`,
        });
      },
      settingsPath(_cwd, homeDir) {
        return `${homeDir}/.alpha/settings.json`;
      },
      install() {
        return Promise.resolve({
          path: "/tmp/.alpha/settings.json",
          action: "unchanged",
        });
      },
    },
    {
      name: "beta",
      displayName: "Beta",
      hookEvents: ["commit"],
      parseInput() {
        return {
          toolName: null,
          files: [],
          hookEventName: null,
        };
      },
      detect() {
        return Promise.resolve({ present: false });
      },
      settingsPath(_cwd, homeDir) {
        return `${homeDir}/.beta/settings.json`;
      },
      install() {
        return Promise.resolve({
          path: "/tmp/.beta/settings.json",
          action: "unchanged",
        });
      },
    },
  ];
}

describe("runDoctor", () => {
  test("reports success on a valid config", async () => {
    const { deps, stdout, stderr } = fakeDeps({ load: loaded() });
    const report = await runDoctor(deps);
    expect(report).toEqual({ ok: true, exitCode: 0 });
    expect(stdout()).toContain("Config loaded");
    expect(stdout()).toContain("1 steps, 1 pipelines");
    expect(stdout()).toContain("pipeline step references resolve");
    expect(stderr()).toBe("");
  });

  test("mentions local override path when present", async () => {
    const { deps, stdout } = fakeDeps({
      load: loaded({ localPath: "/repo/.config/agent-hooks.local.yml" }),
    });
    await runDoctor(deps);
    expect(stdout()).toContain("local override");
    expect(stdout()).toContain("agent-hooks.local.yml");
  });

  test("flags pipelines that reference undefined steps", async () => {
    const broken = ConfigSchema.parse({
      steps: { lint: { run: "eslint {files}" } },
      pipelines: { ci: { steps: ["lint", "ghost"] } },
    });
    const { deps, stderr } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: broken,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
    });
    const report = await runDoctor(deps);
    expect(report).toEqual({ ok: false, exitCode: 2 });
    expect(stderr()).toContain("undefined steps");
    expect(stderr()).toContain("pipelines.ci → ghost");
  });

  test("prints ConfigNotFoundError details and exits with code 2", async () => {
    const { deps, stderr } = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(stderr()).toContain("/repo");
    expect(stderr()).toContain("agent-hooks.yml");
  });

  test("prints ConfigError details and exits with code 2", async () => {
    const { deps, stderr } = fakeDeps({
      load: () =>
        Promise.reject(
          new ConfigError("Invalid config", {
            path: "/repo/.config/agent-hooks.yml",
            details: "steps.lint.run: too small",
          }),
        ),
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(stderr()).toContain("Invalid config");
    expect(stderr()).toContain("too small");
  });

  test("handles ConfigError without details", async () => {
    const { deps, stderr } = fakeDeps({
      load: () =>
        Promise.reject(new ConfigError("config totally broken")),
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(stderr()).toContain("config totally broken");
  });

  test("propagates unexpected errors", async () => {
    const { deps } = fakeDeps({
      load: () => Promise.reject(new TypeError("bug")),
    });
    await expect(runDoctor(deps)).rejects.toThrow(TypeError);
  });

  test("reports 'no auto-resolution layers fired' when env is bare", async () => {
    const bareResolver = {
      fs: { exists: () => Promise.resolve(false) },
      whichCommand: () => Promise.resolve(null),
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      envResolver: bareResolver,
      env: { PATH: "/usr/bin" },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stdout()).toContain("no auto-resolution layers fired");
  });

  test("lists each fired env source with key counts", async () => {
    const cfg = ConfigSchema.parse({
      env: { CONFIG_VAR: "x" },
      steps: { lint: { run: "eslint {files}" } },
      pipelines: { ci: { steps: ["lint"] } },
    });
    const fakeResolver = {
      fs: {
        exists: (p: string) =>
          Promise.resolve(p.endsWith("/node_modules/.bin")),
      },
      whichCommand: () => Promise.resolve(null),
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const { deps, stdout } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      envResolver: fakeResolver,
      env: { PATH: "/usr/bin" },
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stdout()).toContain("Environment auto-resolution");
    expect(stdout()).toContain("node-bin");
    expect(stdout()).toContain("config");
  });

  test("env-resolution notes are surfaced as warnings", async () => {
    const noisyResolver = {
      fs: {
        exists: (p: string) => Promise.resolve(p.endsWith("/.envrc")),
      },
      whichCommand: () => Promise.resolve(null),
      run: () =>
        Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    };
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      envResolver: noisyResolver,
      env: {},
    });
    await runDoctor(deps);
    expect(stdout()).toContain("⚠");
    expect(stdout()).toContain("direnv");
  });

  test("envResolver: null skips the env-resolution section", async () => {
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      envResolver: null,
    });
    await runDoctor(deps);
    expect(stdout()).not.toContain("Environment");
  });

  test("reports git hook status for missing and mismatched hooks", async () => {
    const cfg = ConfigSchema.parse({
      git: {
        hooks: {
          "pre-commit": { pipeline: "lint" },
          "pre-push": { pipeline: "lint" },
        },
      },
      steps: { lint: { run: "eslint {files}" } },
      pipelines: {
        lint: { steps: ["lint"] },
      },
    });
    const hookFs = memHookFs();
    const driftConfig = ConfigSchema.parse({
      git: {
        hooks: {
          "pre-commit": { pipeline: "other" },
          "pre-push": { pipeline: "lint" },
        },
      },
      steps: { lint: { run: "eslint {files}" } },
      pipelines: {
        lint: { steps: ["lint"] },
      },
    });
    hookFs.files.set(
      "/repo/.git/hooks/pre-commit",
      { contents: buildStub("pre-commit", configHash(driftConfig)), mode: 0o644 },
    );
    // pre-push intentionally omitted to represent a missing managed stub.
    const { deps, stdout } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGitRoot("/repo"),
      hookFs,
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stdout()).toContain("Git hooks:");
    expect(stdout()).toContain("⚠ pre-commit");
    expect(stdout()).toContain("hash mismatch");
    expect(stdout()).toContain("⊘ pre-push");
    expect(stdout()).toContain("stub missing");
  });

  test("runs hook fix remediation with --fix and rewrites problematic stubs", async () => {
    const cfg = ConfigSchema.parse({
      git: {
        hooks: {
          "pre-commit": { pipeline: "lint" },
          "pre-push": { pipeline: "lint" },
        },
      },
      steps: { lint: { run: "eslint {files}" } },
      pipelines: {
        lint: { steps: ["lint"] },
      },
    });
    const hookFs = memHookFs();
    hookFs.files.set(
      "/repo/.git/hooks/pre-commit",
      { contents: "# user managed file\n", mode: 0o644 },
    );
    const { deps, stdout } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGitRoot("/repo"),
      hookFs,
      fix: true,
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stdout()).toContain("↳ fix: applied git hook remediations");
    expect(stdout()).toContain("pre-commit: replaced-foreign");
    expect(stdout()).toContain("pre-push: wrote");
    const installed = await hookFs.read("/repo/.git/hooks/pre-commit");
    expect(installed).toContain("agent-hooks managed hook");
  });

  test("warns when not in a git repository but hooks are configured", async () => {
    const cfg = ConfigSchema.parse({
      git: { hooks: { "pre-commit": { pipeline: "lint" } } },
      steps: { lint: { run: "eslint {files}" } },
      pipelines: { lint: { steps: ["lint"] } },
    });
    const { deps, stderr, stdout } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGitRoot(null),
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stderr()).toContain("not inside a git repository");
    expect(stdout()).toContain("Config loaded");
  });

  test("detects configured agents and reports whether they are present", async () => {
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      agentHandlers: fakeAgentHandlers(true),
    });
    const report = await runDoctor(deps);
    expect(report.ok).toBe(true);
    expect(stdout()).toContain("Agent integrations:");
    expect(stdout()).toContain("✓ alpha");
    expect(stdout()).toContain("⊘ beta");
    expect(stdout()).toContain("[user]");
    expect(stdout()).toContain(".alpha/settings.json");
  });

  test("reports Playwright-Checkpoint as active when both are installed", async () => {
    const cfg = ConfigSchema.parse({
      steps: { lint: { run: "eslint {files}" } },
      pipelines: { ci: { steps: ["lint"] } },
    });
    const { deps, stdout } = fakeDeps({
      load: () =>
        Promise.resolve({
          config: cfg,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      detectPlaywright: () => Promise.resolve(true),
      detectPlaywrightCheckpoint: () => Promise.resolve(true),
    });
    await runDoctor(deps);
    expect(stdout()).toContain("Playwright-Checkpoint:");
    expect(stdout()).toContain("✓ detected — prompts will include checkpoint review guidance");
  });

  test("warns about missing Playwright-Checkpoint when Playwright is detected", async () => {
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      detectPlaywright: () => Promise.resolve(true),
      detectPlaywrightCheckpoint: () => Promise.resolve(false),
    });
    await runDoctor(deps);
    expect(stdout()).toContain("⚠ Playwright detected without playwright-checkpoint");
    expect(stdout()).toContain("install with: bun add -d playwright-checkpoint");
  });

  test("respects quiet mode for Playwright-Checkpoint warnings", async () => {
    const { deps, stdout } = fakeDeps({
      load: loaded(),
      quiet: true,
      detectPlaywright: () => Promise.resolve(true),
      detectPlaywrightCheckpoint: () => Promise.resolve(false),
    });
    await runDoctor(deps);
    expect(stdout()).not.toContain("Playwright detected without playwright-checkpoint");
  });
});

describe("registerDoctorCommand", () => {
  test("registers a `doctor` subcommand with description", () => {
    const program = new Command().exitOverride();
    registerDoctorCommand(program, { load: loaded() });
    const cmd = program.commands.find((c) => c.name() === "doctor");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Validate");
  });

  test("completes quietly when the config is valid", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerDoctorCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: loaded(),
    });
    await program.parseAsync(["doctor"], { from: "user" });
    expect(out).toContain("Config loaded");
  });

  test("forwards --fix to runDoctor", async () => {
    const program = new Command().exitOverride();
    const hookFs = memHookFs();
    const cfgLoaded = () =>
      Promise.resolve({
        config: ConfigSchema.parse({
          git: { hooks: { "pre-commit": { pipeline: "lint" } } },
          steps: { lint: { run: "eslint {files}" } },
          pipelines: { lint: { steps: ["lint"] } },
        }),
        sourcePath: "/repo/.config/agent-hooks.yml",
        localPath: null,
      });
    let out = "";
    registerDoctorCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: cfgLoaded,
      makeGit: () => stubGitRoot("/repo"),
      hookFs,
    });
    await program.parseAsync(["doctor", "--fix"], { from: "user" });
    expect(out).toContain("↳ fix: applied git hook remediations");
  });

  test("--quiet suppresses Playwright checkpoint promotion warnings", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerDoctorCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: loaded(),
      detectPlaywright: () => Promise.resolve(true),
      detectPlaywrightCheckpoint: () => Promise.resolve(false),
    });
    await program.parseAsync(["doctor", "--quiet"], { from: "user" });
    expect(out).not.toContain("Playwright detected without playwright-checkpoint");
  });

  test("throws ExitError with code 2 when config is missing", async () => {
    const program = new Command().exitOverride();
    registerDoctorCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/agent-hooks.yml"]),
        ),
    });
    try {
      await program.parseAsync(["doctor"], { from: "user" });
      throw new Error("expected doctor to throw");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect((err as ExitError).exitCode).toBe(2);
    }
  });

  test("defaults cwd/write/writeErr/load when not overridden", async () => {
    // Cover the `?? defaultDoctorDeps.*` fallbacks by registering the
    // command with no overrides and invoking it against a temp dir where
    // no config exists — expect ExitError to bubble.
    const program = new Command().exitOverride();
    registerDoctorCommand(program);

    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    const originalCwd = process.cwd();
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.chdir("/tmp");
    try {
      await program.parseAsync(["doctor"], { from: "user" });
      throw new Error("expected doctor to throw");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      process.chdir(originalCwd);
    }
  });
});

describe("defaultDoctorDeps", () => {
  test("write forwards to process.stdout", () => {
    const original = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured +=
        typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      defaultDoctorDeps.write("ok");
    } finally {
      process.stdout.write = original;
    }
    expect(captured).toBe("ok");
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
      defaultDoctorDeps.writeErr("bad");
    } finally {
      process.stderr.write = original;
    }
    expect(captured).toBe("bad");
  });

  test("load delegates to loadConfig (real FS, expected to reject in a dir without config)", async () => {
    await expect(defaultDoctorDeps.load("/tmp")).rejects.toThrow(
      ConfigNotFoundError,
    );
  });
});
