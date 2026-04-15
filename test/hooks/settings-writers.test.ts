import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../src/config/schema.ts";
import {
  buildClaudeStyleHooks,
  buildShellStub,
  installClaudeStyleSettings,
  installShellStub,
  mergeClaudeStyleSettings,
} from "../../src/hooks/settings-writers.ts";
import type { AgentFs, AgentInstallContext } from "../../src/hooks/types.ts";

function memFs(): AgentFs & { files: Map<string, string> } {
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

function ctx(
  overrides: Partial<AgentInstallContext> & { fs: AgentFs },
): AgentInstallContext {
  return {
    config: ConfigSchema.parse({}),
    cwd: "/repo",
    homeDir: "/home/t",
    scope: "project",
    ...overrides,
  };
}

describe("buildClaudeStyleHooks", () => {
  test("emits entries for each event in the agent's hooks block", () => {
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [
              { matcher: "Edit", pipeline: "agent-edit" },
              { pipeline: "agent-edit" },
            ],
            Stop: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    const result = buildClaudeStyleHooks(config, "claude-code", "claude");
    expect(result.PostToolUse).toHaveLength(2);
    expect(result.PostToolUse?.[0]?.matcher).toBe("Edit");
    expect(result.PostToolUse?.[0]?.hooks[0]?.command).toBe(
      "agent-hooks hook claude PostToolUse",
    );
    expect(result.PostToolUse?.[1]?.matcher).toBeUndefined();
    expect(result.Stop).toHaveLength(1);
  });

  test("returns an empty object when the agent has no hooks", () => {
    const config = ConfigSchema.parse({});
    expect(buildClaudeStyleHooks(config, "claude-code", "claude")).toEqual({});
  });
});

describe("mergeClaudeStyleSettings", () => {
  test("preserves foreign entries and appends generated ones", () => {
    const existing = {
      permissions: { ok: true },
      hooks: {
        PreToolUse: [
          {
            matcher: "X",
            hooks: [{ type: "command", command: "echo pre" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo user" }],
          },
        ],
      },
    };
    const generated = {
      PostToolUse: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command: "agent-hooks hook claude PostToolUse",
            },
          ],
        },
      ],
    };
    const merged = mergeClaudeStyleSettings(existing, generated, "claude");
    expect(merged.permissions).toEqual({ ok: true });
    const hooks = merged.hooks as Record<
      string,
      { matcher?: string; hooks?: { command?: string }[] }[]
    >;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PostToolUse?.length).toBe(2);
    expect(hooks.PostToolUse?.map((h) => h.matcher)).toEqual(["Bash", "Edit"]);
  });

  test("drops previous agent-hooks entries when re-installing", () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [
              {
                type: "command",
                command: "agent-hooks hook claude PostToolUse",
              },
            ],
          },
        ],
      },
    };
    const generated = {
      PostToolUse: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command: "agent-hooks hook claude PostToolUse",
            },
          ],
        },
      ],
    };
    const merged = mergeClaudeStyleSettings(existing, generated, "claude");
    const hooks = merged.hooks as Record<
      string,
      { matcher?: string }[]
    >;
    expect(hooks.PostToolUse?.length).toBe(1);
    expect(hooks.PostToolUse?.[0]?.matcher).toBe("Edit");
  });

  test("creates hooks block when none existed", () => {
    const generated = {
      Stop: [
        { hooks: [{ type: "command", command: "agent-hooks hook claude Stop" }] },
      ],
    };
    const merged = mergeClaudeStyleSettings({}, generated, "claude");
    expect(merged.hooks).toBeDefined();
  });

  test("handles entries with undefined hooks array in existing", () => {
    const existing = {
      hooks: {
        PostToolUse: undefined,
        PreToolUse: [{ matcher: "X" }],
      },
    };
    const merged = mergeClaudeStyleSettings(
      existing as unknown as Record<string, unknown>,
      {
        PostToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: "agent-hooks hook claude PostToolUse",
              },
            ],
          },
        ],
      },
      "claude",
    );
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toHaveLength(1);
  });
});

describe("installClaudeStyleSettings", () => {
  test("returns unchanged when the config has no hooks for the agent", async () => {
    const fs = memFs();
    const result = await installClaudeStyleSettings(
      ctx({ fs }),
      "/repo/.claude/settings.json",
      "claude-code",
      "claude",
    );
    expect(result.action).toBe("unchanged");
    expect(fs.files.size).toBe(0);
  });

  test("creates a fresh settings file", async () => {
    const fs = memFs();
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    const result = await installClaudeStyleSettings(
      ctx({ fs, config }),
      "/repo/.claude/settings.json",
      "claude-code",
      "claude",
    );
    expect(result.action).toBe("created");
    const parsed = JSON.parse(
      fs.files.get("/repo/.claude/settings.json")!,
    ) as { hooks: unknown };
    expect(parsed.hooks).toBeDefined();
  });

  test("merges into an existing settings file", async () => {
    const fs = memFs();
    fs.files.set(
      "/repo/.claude/settings.json",
      `${JSON.stringify({ permissions: { ok: true } }, null, 2)}\n`,
    );
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    const result = await installClaudeStyleSettings(
      ctx({ fs, config }),
      "/repo/.claude/settings.json",
      "claude-code",
      "claude",
    );
    expect(result.action).toBe("merged");
  });

  test("is idempotent — second install is unchanged", async () => {
    const fs = memFs();
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: {
            PostToolUse: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    await installClaudeStyleSettings(
      ctx({ fs, config }),
      "/repo/.claude/settings.json",
      "claude-code",
      "claude",
    );
    const result = await installClaudeStyleSettings(
      ctx({ fs, config }),
      "/repo/.claude/settings.json",
      "claude-code",
      "claude",
    );
    expect(result.action).toBe("unchanged");
  });

  test("merges into a JSONC file with comments and trailing commas (Cursor-style)", async () => {
    const fs = memFs();
    // The kind of settings.json a Cursor user might have on disk:
    // line comments + trailing commas. JSON.parse would crash here.
    fs.files.set(
      "/repo/.cursor/settings.json",
      `{
  // Cursor: agent settings
  "permissions": {
    "ok": true,
  },
  "extra": [1, 2, 3,], // trailing comma
}
`,
    );
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        cursor: {
          hooks: {
            postToolUse: [{ pipeline: "agent-edit" }],
          },
        },
      },
    });
    const result = await installClaudeStyleSettings(
      ctx({ fs, config }),
      "/repo/.cursor/settings.json",
      "cursor",
      "cursor",
    );
    expect(result.action).toBe("merged");
    // Output is strict JSON (comments dropped, no trailing commas) —
    // documented behaviour: agent-hooks owns the `hooks` block, the
    // file gets reformatted on write.
    const written = fs.files.get("/repo/.cursor/settings.json")!;
    const parsed = JSON.parse(written) as Record<string, unknown>;
    expect(parsed.hooks).toBeDefined();
    // Foreign top-level keys are preserved.
    expect(parsed.permissions).toEqual({ ok: true });
    expect(parsed.extra).toEqual([1, 2, 3]);
  });

  test("handles targets without a directory component", async () => {
    const fs = memFs();
    const config = ConfigSchema.parse({
      steps: { lint: { run: "echo" } },
      pipelines: { "agent-edit": { steps: ["lint"] } },
      agents: {
        "claude-code": {
          hooks: { PostToolUse: [{ pipeline: "agent-edit" }] },
        },
      },
    });
    const result = await installClaudeStyleSettings(
      ctx({ fs, config }),
      "settings.json",
      "claude-code",
      "claude",
    );
    expect(result.action).toBe("created");
  });
});

describe("buildShellStub + installShellStub", () => {
  test("includes shebang, dispatch name, and all event names", () => {
    const stub = buildShellStub({
      dispatchName: "cline",
      hookEvents: ["PreToolUse", "PostToolUse", "Stop"],
    });
    expect(stub.startsWith("#!/bin/sh")).toBe(true);
    expect(stub).toContain("# dispatch: cline");
    expect(stub).toContain("PreToolUse|PostToolUse|Stop");
    expect(stub).toContain('exec agent-hooks hook cline "$EVENT"');
  });

  test("comment line is omitted when not provided", () => {
    const stub = buildShellStub({
      dispatchName: "x",
      hookEvents: ["A"],
    });
    expect(stub).not.toContain("# Invoked by");
  });

  test("comment line is included when provided", () => {
    const stub = buildShellStub({
      dispatchName: "x",
      hookEvents: ["A"],
      comment: "custom note",
    });
    expect(stub).toContain("# custom note");
  });

  function ctxWithDroid(fs: AgentFs): AgentInstallContext {
    return ctx({
      fs,
      config: ConfigSchema.parse({
        steps: { lint: { run: "echo" } },
        pipelines: { "agent-edit": { steps: ["lint"] } },
        agents: {
          droid: {
            hooks: {
              PostToolUse: [{ pipeline: "agent-edit" }],
            },
          },
        },
      }),
    });
  }

  test("installShellStub writes a new file and reports created", async () => {
    const fs = memFs();
    const result = await installShellStub(
      ctxWithDroid(fs),
      "/repo/hooks/stub.sh",
      "droid",
      {
        dispatchName: "droid",
        hookEvents: ["PostToolUse"],
      },
    );
    expect(result.action).toBe("created");
    expect(fs.files.has("/repo/hooks/stub.sh")).toBe(true);
  });

  test("installShellStub is idempotent", async () => {
    const fs = memFs();
    await installShellStub(ctxWithDroid(fs), "/repo/hooks/stub.sh", "droid", {
      dispatchName: "droid",
      hookEvents: ["PostToolUse"],
    });
    const result = await installShellStub(
      ctxWithDroid(fs),
      "/repo/hooks/stub.sh",
      "droid",
      {
        dispatchName: "droid",
        hookEvents: ["PostToolUse"],
      },
    );
    expect(result.action).toBe("unchanged");
  });

  test("installShellStub rewrites when contents differ", async () => {
    const fs = memFs();
    await installShellStub(ctxWithDroid(fs), "/repo/hooks/stub.sh", "droid", {
      dispatchName: "droid",
      hookEvents: ["PostToolUse"],
    });
    const result = await installShellStub(
      ctxWithDroid(fs),
      "/repo/hooks/stub.sh",
      "droid",
      {
        dispatchName: "droid",
        hookEvents: ["PostToolUse", "Stop"],
      },
    );
    expect(result.action).toBe("merged");
  });

  test("installShellStub returns unchanged when agent has no rules", async () => {
    const fs = memFs();
    const result = await installShellStub(
      ctx({ fs }),
      "/repo/hooks/stub.sh",
      "droid",
      {
        dispatchName: "droid",
        hookEvents: ["PostToolUse"],
      },
    );
    expect(result.action).toBe("unchanged");
    expect(fs.files.size).toBe(0);
  });
});
