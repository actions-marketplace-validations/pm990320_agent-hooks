import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { ExitError } from "../../src/cli.ts";
import {
  defaultAgentDeps,
  registerAgentCommand,
  runAgentInstall,
  runAgentList,
  runSkillInstall,
  runSkillList,
  runSkillUninstall,
  type AgentCommandDeps,
} from "../../src/commands/agent.ts";
import type { InitFs } from "../../src/commands/init.ts";
import { ConfigError, ConfigNotFoundError } from "../../src/config/errors.ts";
import type { LoadedConfig } from "../../src/config/load.ts";
import { ConfigSchema } from "../../src/config/schema.ts";
import type { SkillFs } from "../../src/integrations/skill/install.ts";

function memFs(): InitFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: (p) => Promise.resolve(files.has(p)),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(v);
    },
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    mkdirRecursive: () => Promise.resolve(),
  };
}

function memSkillFs(): SkillFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    mkdirRecursive: () => Promise.resolve(),
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    exists: (p) => Promise.resolve(files.has(p)),
    remove: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
  };
}

function claudeConfig(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [
              { matcher: "Edit|Write", pipeline: "agent-edit" },
            ],
          },
        },
      },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function geminiConfig(): LoadedConfig {
  return {
    config: ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "gemini-cli": {
          hooks: {
            BeforeTool: [{ matcher: "Edit", pipeline: "agent-edit" }],
          },
        },
      },
    }),
    sourcePath: "/repo/.config/agent-hooks.yml",
    localPath: null,
  };
}

function makeDeps(
  overrides: Partial<AgentCommandDeps> = {},
): AgentCommandDeps {
  return {
    cwd: "/repo",
    homeDir: "/home/test",
    write: () => {},
    writeErr: () => {},
    load: () => Promise.resolve(claudeConfig()),
    fs: memFs(),
    ...overrides,
  };
}

describe("runAgentInstall", () => {
  test("rejects unknown agent names", async () => {
    let err = "";
    const code = await runAgentInstall(
      "nope",
      makeDeps({
        writeErr: (t) => {
          err += t;
        },
      }),
    );
    expect(code).toBe(2);
    expect(err).toContain("unknown agent");
    expect(err).toContain("generic");
  });

  test("generic prints the shell snippet", async () => {
    let out = "";
    const code = await runAgentInstall(
      "generic",
      makeDeps({
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("agent-hooks hook generic edit");
  });

  test("claude writes a settings file with hook entries", async () => {
    const fsMem = memFs();
    let out = "";
    const code = await runAgentInstall(
      "claude",
      makeDeps({
        write: (t) => {
          out += t;
        },
        fs: fsMem,
      }),
    );
    expect(code).toBe(0);
    const written = fsMem.files.get("/repo/.claude/settings.json");
    expect(written).toBeDefined();
    expect(out).toContain("Claude Code");
  });

  test("claude merges into an existing settings file", async () => {
    const fsMem = memFs();
    fsMem.files.set(
      "/repo/.claude/settings.json",
      JSON.stringify({ permissions: { foo: true } }, null, 2),
    );
    await runAgentInstall("claude", makeDeps({ fs: fsMem }));
    const parsed = JSON.parse(
      fsMem.files.get("/repo/.claude/settings.json")!,
    ) as { permissions: { foo: boolean }; hooks: unknown };
    expect(parsed.permissions.foo).toBe(true);
    expect(parsed.hooks).toBeDefined();
  });

  test("claude is idempotent — second install is 'no change'", async () => {
    const fsMem = memFs();
    await runAgentInstall("claude", makeDeps({ fs: fsMem }));
    let out = "";
    await runAgentInstall(
      "claude",
      makeDeps({
        fs: fsMem,
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(out).toContain("no change");
  });

  test("gemini-cli writes .gemini/settings.json", async () => {
    const fsMem = memFs();
    const code = await runAgentInstall(
      "gemini-cli",
      makeDeps({
        fs: fsMem,
        load: () => Promise.resolve(geminiConfig()),
      }),
    );
    expect(code).toBe(0);
    expect(fsMem.files.has("/repo/.gemini/settings.json")).toBe(true);
  });

  test("droid writes to a user-scoped path when scope=user", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        droid: {
          hooks: {
            PostToolUse: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    const fsMem = memFs();
    const code = await runAgentInstall(
      "droid",
      makeDeps({
        fs: fsMem,
        homeDir: "/home/bob",
        load: () =>
          Promise.resolve({
            config,
            sourcePath: "/repo/.config/agent-hooks.yml",
            localPath: null,
          }),
      }),
      "user",
    );
    expect(code).toBe(0);
    expect(fsMem.files.has("/home/bob/.factory/settings.json")).toBe(true);
  });

  test("reports 'no change' when the agent has no configured hooks", async () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { ci: { steps: ["lint"] } },
    });
    let out = "";
    const code = await runAgentInstall(
      "claude",
      makeDeps({
        load: () =>
          Promise.resolve({
            config,
            sourcePath: "/repo/.config/agent-hooks.yml",
            localPath: null,
          }),
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("no change");
  });

  test("returns 2 on ConfigNotFoundError", async () => {
    const code = await runAgentInstall(
      "claude",
      makeDeps({
        load: () =>
          Promise.reject(new ConfigNotFoundError("/repo", ["/repo/ah.yml"])),
      }),
    );
    expect(code).toBe(2);
  });

  test("returns 2 on ConfigError", async () => {
    const code = await runAgentInstall(
      "claude",
      makeDeps({
        load: () =>
          Promise.reject(
            new ConfigError("Invalid", {
              path: "/repo/ah.yml",
              details: "bad",
            }),
          ),
      }),
    );
    expect(code).toBe(2);
  });

  test("propagates unexpected load errors", async () => {
    await expect(
      runAgentInstall(
        "claude",
        makeDeps({
          load: () => Promise.reject(new TypeError("boom")),
        }),
      ),
    ).rejects.toThrow(TypeError);
  });

  test("returns 2 when existing settings file is invalid JSON", async () => {
    const fsMem = memFs();
    fsMem.files.set("/repo/.claude/settings.json", "not json");
    let err = "";
    const code = await runAgentInstall(
      "claude",
      makeDeps({
        fs: fsMem,
        writeErr: (t) => {
          err += t;
        },
      }),
    );
    expect(code).toBe(2);
    expect(err).toContain("failed to parse");
  });

  test("propagates unexpected errors from the handler's install method", async () => {
    const files = new Map<string, string>();
    files.set("/repo/.claude/settings.json", "{}");
    const failingFs: InitFs & { files: Map<string, string> } = {
      files,
      exists: (p) => Promise.resolve(files.has(p)),
      read: () => Promise.reject(new TypeError("boom")),
      write: (p, contents) => {
        files.set(p, contents);
        return Promise.resolve();
      },
      mkdirRecursive: () => Promise.resolve(),
    };
    await expect(
      runAgentInstall("claude", makeDeps({ fs: failingFs })),
    ).rejects.toThrow(TypeError);
  });
});

describe("runAgentList", () => {
  test("prints each known agent with a detection marker", async () => {
    let out = "";
    const code = await runAgentList(
      makeDeps({
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("Known agents:");
    expect(out).toContain("claude");
    expect(out).toContain("gemini-cli");
    expect(out).toContain("droid");
  });

  test("shows a present marker for agents whose dir exists", async () => {
    const fsMem = memFs();
    fsMem.files.set("/repo/.claude", ""); // dir marker
    let out = "";
    await runAgentList(
      makeDeps({
        fs: fsMem,
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(out).toContain("✓");
  });
});

describe("registerAgentCommand", () => {
  test("agent install <name> fires the correct handler", async () => {
    const program = new Command().exitOverride();
    const fsMem = memFs();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: fsMem,
    });
    await program.parseAsync(["agent", "install", "claude"], {
      from: "user",
    });
    expect(fsMem.files.has("/repo/.claude/settings.json")).toBe(true);
  });

  test("agent install supports --scope user", async () => {
    const program = new Command().exitOverride();
    const fsMem = memFs();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: fsMem,
    });
    await program.parseAsync(
      ["agent", "install", "claude", "--scope", "user"],
      { from: "user" },
    );
    expect(fsMem.files.has("/home/t/.claude/settings.json")).toBe(true);
  });

  test("agent install throws ExitError on unknown agent", async () => {
    const program = new Command().exitOverride();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
    });
    try {
      await program.parseAsync(["agent", "install", "nope"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
    }
  });

  test("agent list command fires", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
    });
    await program.parseAsync(["agent", "list"], { from: "user" });
    expect(out).toContain("Known agents:");
  });

  test("registers with default deps (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerAgentCommand(program);
    expect(cmd).toBeDefined();
  });
});

describe("runSkillInstall / runSkillUninstall", () => {
  test("installs a skill for a valid target", async () => {
    const fsMem = memSkillFs();
    const code = await runSkillInstall(
      { target: "claude", project: true },
      makeDeps({
        skillFs: fsMem,
        loadSkillTemplate: () => Promise.resolve("SKILL"),
      }),
    );
    expect(code).toBe(0);
    expect(fsMem.files.size).toBe(1);
  });

  test("rejects unknown skill targets on install", async () => {
    const code = await runSkillInstall(
      { target: "nope" },
      makeDeps({
        skillFs: memSkillFs(),
        loadSkillTemplate: () => Promise.resolve(""),
      }),
    );
    expect(code).toBe(2);
  });

  test("uninstalls a previously installed skill", async () => {
    const fsMem = memSkillFs();
    await runSkillInstall(
      { target: "cursor", project: true },
      makeDeps({
        skillFs: fsMem,
        loadSkillTemplate: () => Promise.resolve("SKILL"),
      }),
    );
    let out = "";
    const code = await runSkillUninstall(
      { target: "cursor", project: true },
      makeDeps({
        skillFs: fsMem,
        loadSkillTemplate: () => Promise.resolve(""),
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("removed skill");
  });

  test("uninstall reports 'not installed'", async () => {
    let out = "";
    const code = await runSkillUninstall(
      { target: "codex" },
      makeDeps({
        skillFs: memSkillFs(),
        loadSkillTemplate: () => Promise.resolve(""),
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("not installed");
  });

  test("uninstall rejects unknown targets", async () => {
    const code = await runSkillUninstall(
      { target: "nope" },
      makeDeps({
        skillFs: memSkillFs(),
        loadSkillTemplate: () => Promise.resolve(""),
      }),
    );
    expect(code).toBe(2);
  });
});

describe("runSkillList", () => {
  test("reports nothing installed on a fresh machine", async () => {
    let out = "";
    const code = await runSkillList(
      makeDeps({
        skillFs: memSkillFs(),
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    expect(out).toContain("agent-hooks skill locations");
    expect(out).toContain("claude");
    expect(out).toContain("cursor");
    expect(out).toContain("codex");
    expect(out).toContain("no skills installed yet");
  });

  test("marks installed skills with a check glyph", async () => {
    const fsMem = memSkillFs();
    // Install a user-scope claude skill so it shows up in the listing.
    await runSkillInstall(
      { target: "claude" },
      makeDeps({
        skillFs: fsMem,
        loadSkillTemplate: () => Promise.resolve("SKILL"),
      }),
    );
    let out = "";
    const code = await runSkillList(
      makeDeps({
        skillFs: fsMem,
        write: (t) => {
          out += t;
        },
      }),
    );
    expect(code).toBe(0);
    // We installed one — so the "nothing installed" line should NOT appear.
    expect(out).not.toContain("no skills installed yet");
    expect(out).toContain("✓");
  });
});

describe("registerAgentCommand — skill subcommands", () => {
  test("agent skill install writes the file", async () => {
    const program = new Command().exitOverride();
    const fsMem = memSkillFs();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
      skillFs: fsMem,
      loadSkillTemplate: () => Promise.resolve("SKILL"),
    });
    await program.parseAsync(
      ["agent", "skill", "install", "claude", "--project"],
      { from: "user" },
    );
    expect(fsMem.files.size).toBe(1);
  });

  test("agent skill install ExitError on bad target", async () => {
    const program = new Command().exitOverride();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
      skillFs: memSkillFs(),
      loadSkillTemplate: () => Promise.resolve(""),
    });
    try {
      await program.parseAsync(["agent", "skill", "install", "bad"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
    }
  });

  test("agent skill uninstall fires", async () => {
    const program = new Command().exitOverride();
    const fsMem = memSkillFs();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
      skillFs: fsMem,
      loadSkillTemplate: () => Promise.resolve("SKILL"),
    });
    await program.parseAsync(
      ["agent", "skill", "install", "codex", "--project"],
      { from: "user" },
    );
    await program.parseAsync(
      ["agent", "skill", "uninstall", "codex", "--project"],
      { from: "user" },
    );
    expect(fsMem.files.size).toBe(0);
  });

  test("agent skill uninstall ExitError on bad target", async () => {
    const program = new Command().exitOverride();
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: () => {},
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
      skillFs: memSkillFs(),
      loadSkillTemplate: () => Promise.resolve(""),
    });
    try {
      await program.parseAsync(["agent", "skill", "uninstall", "nope"], {
        from: "user",
      });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err instanceof ExitError).toBe(true);
    }
  });

  test("agent skill list wiring runs end-to-end", async () => {
    const program = new Command().exitOverride();
    let out = "";
    registerAgentCommand(program, {
      cwd: "/repo",
      homeDir: "/home/t",
      write: (t) => {
        out += t;
      },
      writeErr: () => {},
      load: () => Promise.resolve(claudeConfig()),
      fs: memFs(),
      skillFs: memSkillFs(),
      loadSkillTemplate: () => Promise.resolve("SKILL"),
    });
    await program.parseAsync(["agent", "skill", "list"], { from: "user" });
    expect(out).toContain("skill locations");
  });
});

describe("defaultAgentDeps", () => {
  test("exposes all required slots", () => {
    expect(typeof defaultAgentDeps.write).toBe("function");
    expect(typeof defaultAgentDeps.writeErr).toBe("function");
    expect(typeof defaultAgentDeps.load).toBe("function");
    expect(typeof defaultAgentDeps.homeDir).toBe("string");
    expect(defaultAgentDeps.fs).toBeDefined();
  });
});
