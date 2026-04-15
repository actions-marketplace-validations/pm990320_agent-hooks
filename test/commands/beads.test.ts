import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  defaultBeadsDeps,
  registerBeadsCommand,
  runBeadsPostSyncCommand,
  type BeadsCommandDeps,
} from "../../src/commands/beads.ts";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { BeadsFs } from "../../src/integrations/beads/detect.ts";
import type { ExecFn, ExecInput } from "../../src/runners/step.ts";

function loaded(enabled: "auto" | boolean = "auto"): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { ci: { steps: ["lint"] } },
      beads: { enabled },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function okExec(): { exec: ExecFn; calls: ExecInput[] } {
  const calls: ExecInput[] = [];
  const steps = [0, 0, 0, 0]; // sync, status, add, commit
  let i = 0;
  const exec: ExecFn = (input) => {
    calls.push(input);
    return Promise.resolve({ exitCode: steps[i++] ?? 0, durationMs: 1 });
  };
  return { exec, calls };
}

function fsExists(flag: boolean): BeadsFs {
  return { exists: () => Promise.resolve(flag) };
}

describe("runBeadsPostSyncCommand", () => {
  test("returns 0 and prints message when beads isn't detected", async () => {
    let out = "";
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(loaded("auto")),
      exec: okExec().exec,
      fs: fsExists(false),
    });
    expect(code).toBe(0);
    expect(out).toContain("not detected");
  });

  test("runs post-sync and commits when beads is detected", async () => {
    const { exec } = okExec();
    let out = "";
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    expect(code).toBe(0);
    expect(out).toContain("sync committed");
  });

  test("reports 'no changes' path", async () => {
    const calls: ExecInput[] = [];
    const exits = [0, 0, 0, 1];
    let i = 0;
    const exec: ExecFn = (input) => {
      calls.push(input);
      return Promise.resolve({ exitCode: exits[i++] ?? 0, durationMs: 1 });
    };
    let out = "";
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    expect(code).toBe(0);
    expect(out).toContain("no changes");
  });

  test("returns non-zero when bd sync fails", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({ exitCode: 2, durationMs: 1 });
    let err = "";
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    expect(code).toBe(2);
    expect(err).toContain("bd sync failed");
  });

  test("returns non-zero when git commit fails hard", async () => {
    const exits = [0, 0, 0, 3];
    let i = 0;
    const exec: ExecFn = () =>
      Promise.resolve({ exitCode: exits[i++] ?? 0, durationMs: 1 });
    let err = "";
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: () => {},
      writeErr: (t) => {
        err += t;
      },
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    expect(code).toBe(3);
    expect(err).toContain("follow-up commit failed");
  });

  test("returns 2 on ConfigNotFoundError", async () => {
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(new ConfigNotFoundError("/repo", ["/repo/ah.yml"])),
      exec: okExec().exec,
      fs: fsExists(true),
    });
    expect(code).toBe(2);
  });

  test("returns 2 on ConfigError", async () => {
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(
          new ConfigError("Invalid", { path: "/r/y", details: "d" }),
        ),
      exec: okExec().exec,
      fs: fsExists(true),
    });
    expect(code).toBe(2);
  });

  test("propagates unexpected load errors", async () => {
    await expect(
      runBeadsPostSyncCommand({
        cwd: "/repo",
        write: () => {},
        writeErr: () => {},
        load: () => Promise.reject(new TypeError("boom")),
        exec: okExec().exec,
        fs: fsExists(true),
      }),
    ).rejects.toThrow(TypeError);
  });

  test("add-failed path surfaces commit-failed status", async () => {
    const exits = [0, 0, 4];
    let i = 0;
    const exec: ExecFn = () =>
      Promise.resolve({ exitCode: exits[i++] ?? 0, durationMs: 1 });
    const code = await runBeadsPostSyncCommand({
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    expect(code).toBe(4);
  });
});

describe("registerBeadsCommand", () => {
  test("registers beads post-sync and runs it", async () => {
    const program = new Command().exitOverride();
    const { exec } = okExec();
    let out = "";
    registerBeadsCommand(program, {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(loaded("auto")),
      exec,
      fs: fsExists(true),
    });
    await program.parseAsync(["beads", "post-sync"], { from: "user" });
    expect(out).toContain("sync committed");
  });

  test("throws ExitError on failure", async () => {
    const program = new Command().exitOverride();
    registerBeadsCommand(program, {
      cwd: "/repo",
      write: () => {},
      writeErr: () => {},
      load: () =>
        Promise.reject(new ConfigNotFoundError("/repo", ["/repo/ah.yml"])),
      exec: okExec().exec,
      fs: fsExists(true),
    });
    try {
      await program.parseAsync(["beads", "post-sync"], { from: "user" });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
    }
  });

  test("registers with default deps (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerBeadsCommand(program);
    expect(cmd).toBeDefined();
  });
});

describe("defaultBeadsDeps", () => {
  test("exposes all required slots", () => {
    expect(typeof defaultBeadsDeps.write).toBe("function");
    expect(typeof defaultBeadsDeps.writeErr).toBe("function");
    expect(typeof defaultBeadsDeps.load).toBe("function");
    expect(typeof defaultBeadsDeps.exec).toBe("function");
    expect(defaultBeadsDeps.fs).toBeDefined();
  });
});

// silence unused type import
void ({} as BeadsCommandDeps);
