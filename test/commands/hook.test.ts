import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  readStdinStream,
  registerHookCommand,
  runHookCommand,
  runHookListCommand,
  type HookCommandDeps,
} from "../../src/commands/hook.ts";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import type { GitRunner } from "../../src/runners/files.ts";
import type { ExecFn } from "../../src/runners/step.ts";

function stubGit(files: readonly string[] = []): GitRunner {
  return {
    staged: () => Promise.resolve(files),
    changed: () => Promise.resolve(files),
    all: () => Promise.resolve(files),
  };
}

function stubLoaded(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo lint {files}" } },
      pipelines: { "pre-commit": { steps: ["lint"] } },
      git: { hooks: { "pre-commit": { pipeline: "pre-commit" } } },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function stubLoadedWithClaude(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo lint {files}" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [
              { matcher: "Edit|Write", pipeline: "agent-edit" },
            ],
            Stop: [{ pipeline: "ghost" }],
          },
        },
      },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function fakeExec(exit = 0): ExecFn {
  return () => Promise.resolve({ exitCode: exit, durationMs: 1 });
}

function fakeStdin(text = ""): HookCommandDeps["readStdin"] {
  return () => Promise.resolve(text);
}

describe("runHookCommand", () => {
  test("rejects unknown agents with exit 2", async () => {
    let err = "";
    const code = await runHookCommand("unknown-agent", "Something", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: fakeExec(),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(2);
    expect(err).toContain("unknown hook agent");
  });

  test("returns 2 when the config cannot be loaded", async () => {
    let err = "";
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () =>
        Promise.reject(new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"])),
      makeGit: () => stubGit(),
      exec: fakeExec(),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(2);
    expect(err).toContain("/repo");
  });

  test("returns 2 when the loaded config is invalid", async () => {
    let err = "";
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () =>
        Promise.reject(
          new ConfigError("Invalid", {
            path: "/repo/.config/agent-hooks.yml",
            details: "bad",
          }),
        ),
      makeGit: () => stubGit(),
      exec: fakeExec(),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(2);
    expect(err).toContain("Invalid");
    expect(err).toContain("bad");
  });

  test("propagates unexpected load errors", async () => {
    await expect(
      runHookCommand("git", "pre-commit", {
        cwd: "/repo",
        write: () => {},
        writeErr: () => {},
        load: () => Promise.reject(new TypeError("boom")),
        makeGit: () => stubGit(),
        exec: fakeExec(),
        readStdin: fakeStdin(),
        env: {},
      }),
    ).rejects.toThrow(TypeError);
  });

  test("returns 0 when there is no rule for the hook", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { lint: { steps: ["lint"] } },
    });
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.resolve({
          config,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGit(),
      exec: fakeExec(),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(0);
  });

  test("returns 2 when the rule references an undefined pipeline", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { lint: { steps: ["lint"] } },
      git: { hooks: { "pre-commit": { pipeline: "ghost" } } },
    });
    let err = "";
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () =>
        Promise.resolve({
          config,
          sourcePath: "/repo/.config/agent-hooks.yml",
          localPath: null,
        }),
      makeGit: () => stubGit(),
      exec: fakeExec(),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(2);
    expect(err).toContain("undefined pipeline");
  });

  test("runs the configured pipeline and returns its exit code", async () => {
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(["src/a.ts"]),
      exec: fakeExec(0),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(0);
  });

  test("propagates non-zero pipeline exit codes", async () => {
    const code = await runHookCommand("git", "pre-commit", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(["src/a.ts"]),
      exec: fakeExec(5),
      readStdin: fakeStdin(),
      env: {},
    });
    expect(code).toBe(5);
  });
});

describe("registerHookCommand", () => {
  test("registers the subcommand and throws ExitError on non-zero", async () => {
    const program = new Command().exitOverride();
    registerHookCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(["src/a.ts"]),
      exec: fakeExec(4),
      readStdin: fakeStdin(),
      env: {},
    });
    try {
      await program.parseAsync(["hook", "git", "pre-commit"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect((err as ExitError).exitCode).toBe(4);
    }
  });

  test("succeeds silently when pipeline passes", async () => {
    const program = new Command().exitOverride();
    registerHookCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(["src/a.ts"]),
      exec: fakeExec(0),
      readStdin: fakeStdin(),
      env: {},
    });
    await program.parseAsync(["hook", "git", "pre-commit"], { from: "user" });
  });

  test("registers with default deps when none provided (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerHookCommand(program);
    expect(cmd).toBeDefined();
  });

  test("default-deps action path fires against an unknown agent", async () => {
    const program = new Command().exitOverride();
    registerHookCommand(program);
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await program.parseAsync(["hook", "nope", "whatever"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
      expect((err as ExitError).exitCode).toBe(2);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });

  test("default readStdin arrow fires when claude agent is invoked with only cwd override", async () => {
    // Create a tmp repo with a config so load() succeeds, then invoke
    // `hook claude PreToolUse` which has no rule → returns 0 quickly.
    // The fallback `() => readStdinStream(process.stdin)` arrow is
    // exercised because we only override `cwd`.
    const nodeFs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await nodeFs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-hook-defaults-"),
    );
    try {
      await nodeFs.mkdir(path.join(tmp, ".config"), { recursive: true });
      await nodeFs.writeFile(
        path.join(tmp, ".config", "agent-hooks.yml"),
        "steps:\n  lint:\n    run: echo\npipelines:\n  lint:\n    steps: [lint]\n",
        "utf8",
      );

      const program = new Command().exitOverride();
      registerHookCommand(program, { cwd: tmp });

      const originalIsTTY = process.stdin.isTTY;
      const originalOut = process.stdout.write.bind(process.stdout);
      // Force isTTY so readStdinStream short-circuits without blocking.
      // The isTTY setter is a no-op on some platforms, so we defineProperty.
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        configurable: true,
      });
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        await program.parseAsync(["hook", "claude", "PreToolUse"], {
          from: "user",
        });
      } finally {
        if (originalIsTTY === undefined) {
          Object.defineProperty(process.stdin, "isTTY", {
            value: undefined,
            configurable: true,
          });
        } else {
          Object.defineProperty(process.stdin, "isTTY", {
            value: originalIsTTY,
            configurable: true,
          });
        }
        process.stdout.write = originalOut;
      }
    } finally {
      await nodeFs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("readStdinStream", () => {
  interface FakeStream {
    readonly isTTY?: boolean;
    on(
      event: "data" | "end" | "error",
      cb: (arg?: unknown) => void,
    ): FakeStream;
  }

  test("returns empty string when isTTY is true", async () => {
    const fake: FakeStream = {
      isTTY: true,
      on() {
        return fake;
      },
    };
    expect(await readStdinStream(fake)).toBe("");
  });

  test("accumulates data chunks and resolves on end", async () => {
    const handlers = new Map<string, (arg?: unknown) => void>();
    const fake: FakeStream = {
      isTTY: false,
      on(event, cb) {
        handlers.set(event, cb);
        return fake;
      },
    };
    const promise = readStdinStream(fake);
    handlers.get("data")?.(Buffer.from("hello "));
    handlers.get("data")?.(Buffer.from("world"));
    handlers.get("end")?.();
    expect(await promise).toBe("hello world");
  });

  test("rejects on stream error", async () => {
    const handlers = new Map<string, (arg?: unknown) => void>();
    const fake: FakeStream = {
      isTTY: false,
      on(event, cb) {
        handlers.set(event, cb);
        return fake;
      },
    };
    const promise = readStdinStream(fake);
    handlers.get("error")?.(new Error("boom"));
    await expect(promise).rejects.toThrow("boom");
  });

  test("rejects with StdinNotUtf8Error when input contains invalid UTF-8 bytes", async () => {
    const handlers = new Map<string, (arg?: unknown) => void>();
    const fake: FakeStream = {
      isTTY: false,
      on(event, cb) {
        handlers.set(event, cb);
        return fake;
      },
    };
    const promise = readStdinStream(fake);
    // 0xC3 by itself is the start of a 2-byte UTF-8 sequence with no
    // continuation byte — a TextDecoder fatal: true rejects it.
    handlers.get("data")?.(Buffer.from([0xc3]));
    handlers.get("end")?.();
    await expect(promise).rejects.toThrow(/invalid UTF-8/);
  });

  test("rejects with StdinTooLargeError when input exceeds the cap", async () => {
    const handlers = new Map<string, (arg?: unknown) => void>();
    const fake: FakeStream = {
      isTTY: false,
      on(event, cb) {
        handlers.set(event, cb);
        return fake;
      },
    };
    // Cap is 8 bytes; sending 5 + 5 = 10 should reject after the
    // second chunk lands.
    const promise = readStdinStream(fake, 8);
    handlers.get("data")?.(Buffer.from("aaaaa"));
    handlers.get("data")?.(Buffer.from("bbbbb"));
    await expect(promise).rejects.toThrow(/exceeded the 8-byte/);
  });
});

describe("runHookCommand — claude agent", () => {
  test("runs the agent-edit pipeline when PostToolUse matcher fires", async () => {
    const code = await runHookCommand("claude", "PostToolUse", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoadedWithClaude()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin(
        JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_paths: ["src/a.ts"] },
        }),
      ),
      env: {},
    });
    expect(code).toBe(0);
  });

  test("returns 0 when no rule exists for the given hook name", async () => {
    const code = await runHookCommand("claude", "PreToolUse", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoadedWithClaude()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin("{}"),
      env: {},
    });
    expect(code).toBe(0);
  });

  test("returns 0 when the matcher doesn't fire", async () => {
    const code = await runHookCommand("claude", "PostToolUse", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(stubLoadedWithClaude()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin(
        JSON.stringify({ tool_name: "Bash", tool_input: {} }),
      ),
      env: {},
    });
    expect(code).toBe(0);
  });

  test("returns 2 when the matched pipeline is missing", async () => {
    let err = "";
    const code = await runHookCommand("claude", "Stop", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () => Promise.resolve(stubLoadedWithClaude()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin("{}"),
      env: {},
    });
    expect(code).toBe(2);
    expect(err).toContain("undefined pipeline");
  });

  test("returns 2 when the config cannot be loaded", async () => {
    const code = await runHookCommand("claude", "PostToolUse", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin("{}"),
      env: {},
    });
    expect(code).toBe(2);
  });

  test("returns 2 when the loaded config is invalid", async () => {
    const code = await runHookCommand("claude", "PostToolUse", {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(
          new ConfigError("Invalid", {
            path: "/repo/.config/agent-hooks.yml",
            details: "bad",
          }),
        ),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin("{}"),
      env: {},
    });
    expect(code).toBe(2);
  });

  test("propagates unexpected load errors", async () => {
    await expect(
      runHookCommand("claude", "PostToolUse", {
        cwd: "/repo",
        write: () => {},
        writeErr: () => {},
        load: () => Promise.reject(new TypeError("boom")),
        makeGit: () => stubGit(),
        exec: fakeExec(0),
        readStdin: fakeStdin("{}"),
        env: {},
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("runHookListCommand", () => {
  function depsFor(loaded: LoadedConfig): {
    deps: HookCommandDeps;
    out: () => string;
    err: () => string;
  } {
    let o = "";
    let e = "";
    return {
      deps: {
        cwd: "/repo",
        write: (t) => {
          o += t;
        },
        writeErr: (t) => {
          e += t;
        },
        load: () => Promise.resolve(loaded),
        makeGit: () => stubGit(),
        exec: fakeExec(0),
        readStdin: fakeStdin(""),
        env: {},
      },
      out: () => o,
      err: () => e,
    };
  }

  test("rejects the git agent with exit 2", async () => {
    const { deps, err } = depsFor(stubLoaded());
    const code = await runHookListCommand("git", deps);
    expect(code).toBe(2);
    expect(err()).toContain("doesn't support the git agent");
  });

  test("rejects unknown agents with exit 2", async () => {
    const { deps, err } = depsFor(stubLoaded());
    const code = await runHookListCommand("not-a-real-agent", deps);
    expect(code).toBe(2);
    expect(err()).toContain("unknown hook agent");
  });

  test("returns 2 when config fails to load", async () => {
    let e = "";
    const code = await runHookListCommand("claude", {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        e += t;
      },
      load: () =>
        Promise.reject(
          new ConfigNotFoundError("/repo", ["/repo/.config/agent-hooks.yml"]),
        ),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin(""),
      env: {},
    });
    expect(code).toBe(2);
    expect(e).toContain("/repo");
  });

  test("lists every handler event with a dot when no rules are configured", async () => {
    const { deps, out } = depsFor(stubLoaded());
    const code = await runHookListCommand("claude", deps);
    expect(code).toBe(0);
    expect(out()).toContain("claude");
    expect(out()).toContain("PostToolUse");
    // No rules → dot glyph, no " (N rules)" suffix.
    expect(out()).toContain("· PostToolUse\n");
  });

  test("marks configured events with a check and lists matcher/pipeline", async () => {
    const { deps, out } = depsFor(stubLoadedWithClaude());
    const code = await runHookListCommand("claude", deps);
    expect(code).toBe(0);
    expect(out()).toContain("✓ PostToolUse (1 rule)");
    expect(out()).toContain("matcher: Edit|Write → pipeline: agent-edit");
    expect(out()).toContain("✓ Stop");
    // Stop has an implicit matcher "*".
    expect(out()).toContain("matcher: * → pipeline: ghost");
  });

  test("warns about configured events the handler doesn't recognize", async () => {
    const loaded: LoadedConfig = {
      config: ConfigSchema.parse({
        steps: { lint: { run: "echo" } },
        pipelines: { "agent-edit": { steps: ["lint"] } },
        agents: {
          "claude-code": {
            hooks: {
              PostToolUSE: [{ pipeline: "agent-edit" }],
            },
          },
        },
      }),
      sourcePath: "/repo/.config/agent-hooks.yml",
      localPath: null,
    };
    const { deps, out } = depsFor(loaded);
    const code = await runHookListCommand("claude", deps);
    expect(code).toBe(0);
    expect(out()).toContain("configured events not recognized");
    expect(out()).toContain("PostToolUSE");
  });
});

describe("registerHookCommand — --list", () => {
  test("--list routes to the list command and exits 0", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerHookCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(stubLoadedWithClaude()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin(""),
      env: {},
    });
    await program.parseAsync(["hook", "claude", "--list"], { from: "user" });
    expect(out).toContain("PostToolUse");
  });

  test("missing hook-name without --list exits 2 with a helpful error", async () => {
    const program = new Command().exitOverride();
    let err = "";
    registerHookCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () => Promise.resolve(stubLoaded()),
      makeGit: () => stubGit(),
      exec: fakeExec(0),
      readStdin: fakeStdin(""),
      env: {},
    });
    try {
      await program.parseAsync(["hook", "claude"], { from: "user" });
      throw new Error("expected ExitError");
    } catch (caught) {
      expect(caught instanceof ExitError).toBe(true);
      expect((caught as ExitError).exitCode).toBe(2);
    }
    expect(err).toContain("requires <hook-name>");
  });
});
