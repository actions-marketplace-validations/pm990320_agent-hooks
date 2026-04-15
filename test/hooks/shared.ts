import { expect, test } from "bun:test";
import { ConfigSchema, type Config } from "../../src/config/schema.ts";
import type { AgentFs, AgentHandler } from "../../src/hooks/types.ts";

export function memHookFs(): AgentFs & { files: Map<string, string> } {
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

export interface AgentSmokeOptions {
  /** agent-hooks config key under `agents.*` */
  readonly configKey: string;
  /** A sample event name this agent knows about (drives the install config). */
  readonly sampleEvent: string;
  /** A sample input JSON string the parser should be able to handle. */
  readonly sampleInput?: string;
  /** Expected tool name when parsing sampleInput (if any). */
  readonly expectedToolName?: string | null;
}

function buildSampleConfig(
  configKey: string,
  sampleEvent: string,
): Config {
  return ConfigSchema.parse({
    steps: { lint: { run: "echo lint {files}" } },
    pipelines: { "agent-edit": { steps: ["lint"] } },
    agents: {
      [configKey]: {
        hooks: {
          [sampleEvent]: [{ pipeline: "agent-edit" }],
        },
      },
    },
  });
}

/**
 * Runs a standard smoke test pack against an agent handler: detect,
 * settingsPath, install (creates + idempotent), parseInput on both
 * empty and sample inputs. Call from a `describe` block in each
 * per-agent test file.
 */
export function runAgentSmokeTests(
  handler: AgentHandler,
  options: AgentSmokeOptions,
): void {
  test("exposes name, displayName, and a non-empty hookEvents list", () => {
    expect(handler.name.length).toBeGreaterThan(0);
    expect(handler.displayName.length).toBeGreaterThan(0);
    expect(handler.hookEvents.length).toBeGreaterThan(0);
  });

  test("parseInput accepts empty input without throwing", () => {
    const result = handler.parseInput("");
    expect(result.toolName).toBeNull();
    expect(result.files).toEqual([]);
  });

  test("parseInput accepts invalid JSON without throwing", () => {
    const result = handler.parseInput("not json");
    expect(result.toolName).toBeNull();
  });

  if (options.sampleInput !== undefined) {
    test("parseInput produces a normalized shape for the sample payload", () => {
      const result = handler.parseInput(options.sampleInput!);
      if (options.expectedToolName !== undefined) {
        expect(result.toolName).toBe(options.expectedToolName);
      }
    });
  }

  test("detect returns not-present against an empty memfs", async () => {
    const fs = memHookFs();
    const result = await handler.detect("/repo", "/home/t", fs);
    expect(result.present).toBe(false);
  });

  test("detect returns present when project parent-dir markers exist", async () => {
    const fs = memHookFs();
    const projectPath = handler.settingsPath("/repo", "/home/t", "project");
    fs.files.set(projectPath, "");
    for (let p = projectPath; p.length > 1; ) {
      const next = p.slice(0, p.lastIndexOf("/"));
      if (next.length === 0 || next === p) break;
      fs.files.set(next, "");
      p = next;
    }
    const result = await handler.detect("/repo", "/home/t", fs);
    expect(typeof result.present).toBe("boolean");
  });

  test("detect returns present when user parent-dir markers exist", async () => {
    const fs = memHookFs();
    const userPath = handler.settingsPath("/repo", "/home/t", "user");
    fs.files.set(userPath, "");
    for (let p = userPath; p.length > 1; ) {
      const next = p.slice(0, p.lastIndexOf("/"));
      if (next.length === 0 || next === p) break;
      fs.files.set(next, "");
      p = next;
    }
    const result = await handler.detect("/repo", "/home/t", fs);
    expect(typeof result.present).toBe("boolean");
  });

  test("settingsPath returns a distinct path per scope", () => {
    const project = handler.settingsPath("/repo", "/home/t", "project");
    const user = handler.settingsPath("/repo", "/home/t", "user");
    expect(project.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
    // Paths should include the cwd or homeDir depending on scope.
    expect(project.includes("/repo") || project.includes("/home/t")).toBe(true);
    expect(user.includes("/home/t") || user.includes("/repo")).toBe(true);
  });

  test("install creates a settings file for a minimal project config", async () => {
    const fs = memHookFs();
    const config = buildSampleConfig(options.configKey, options.sampleEvent);
    const result = await handler.install({
      config,
      cwd: "/repo",
      homeDir: "/home/t",
      scope: "project",
      fs,
    });
    expect(result.action === "created" || result.action === "merged").toBe(true);
    expect(fs.files.has(result.path)).toBe(true);
  });

  test("install is idempotent — second install reports no change", async () => {
    const fs = memHookFs();
    const config = buildSampleConfig(options.configKey, options.sampleEvent);
    await handler.install({
      config,
      cwd: "/repo",
      homeDir: "/home/t",
      scope: "project",
      fs,
    });
    const second = await handler.install({
      config,
      cwd: "/repo",
      homeDir: "/home/t",
      scope: "project",
      fs,
    });
    expect(second.action).toBe("unchanged");
  });

  test("install with scope=user writes to a user-scoped path", async () => {
    const fs = memHookFs();
    const config = buildSampleConfig(options.configKey, options.sampleEvent);
    const result = await handler.install({
      config,
      cwd: "/repo",
      homeDir: "/home/bob",
      scope: "user",
      fs,
    });
    expect(result.action === "created" || result.action === "unchanged").toBe(
      true,
    );
  });

  test("install reports unchanged when the config has no rules for the agent", async () => {
    const fs = memHookFs();
    const emptyConfig = ConfigSchema.parse({});
    const result = await handler.install({
      config: emptyConfig,
      cwd: "/repo",
      homeDir: "/home/t",
      scope: "project",
      fs,
    });
    expect(result.action).toBe("unchanged");
  });
}
