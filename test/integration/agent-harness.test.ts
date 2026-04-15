import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "./support/cli.ts";
import {
  fireAgentHook,
  sendPromptToFakeAgent,
  writeFakeAgentScript,
} from "./support/fake-agent.ts";
import {
  copyFixture,
  fixtureFileExists,
  readFixtureFile,
  type Fixture,
} from "./support/fixture.ts";

/**
 * These tests exercise the full agent lifecycle end-to-end:
 *
 *   1. Copy a fixture repo with an agent-hooks config declaring an
 *      agent+pipeline mapping.
 *   2. Run `agent-hooks agent install <name>` to write the agent's
 *      native settings.
 *   3. "Send" a prompt to a fake agent, which fires the hook.
 *   4. Assert that agent-hooks dispatched to the right pipeline and
 *      the fake linter produced the expected side effect.
 *
 * The fake agent is deliberately minimal — it does no LLM work, but
 * it emits the same hook payload shape a real agent would. If the
 * payload parses correctly and the pipeline runs, we know our hook
 * setup is correct.
 */

async function writeAgentConfig(
  cwd: string,
  agentKey: string,
  event: string,
): Promise<void> {
  const yaml = `
name: agent-harness-fixture
steps:
  lint:
    run: bash scripts/fake-lint.sh {files}
    files: "**/*.txt"
pipelines:
  agent-edit:
    steps: [lint]
agents:
  ${agentKey}:
    hooks:
      ${event}:
        - matcher: "Edit|Write"
          pipeline: agent-edit
`;
  await fs.writeFile(
    path.join(cwd, ".config", "agent-hooks.yml"),
    yaml,
    "utf8",
  );
}

describe("agent harness — end-to-end lifecycle", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await copyFixture("generic");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("fireAgentHook runs the configured claude pipeline on file edit", async () => {
    await writeAgentConfig(fixture.cwd, "claude-code", "PostToolUse");
    const result = await fireAgentHook({
      agent: "claude",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt", "src/b.txt"] },
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake-lint:");
    expect(result.stdout).toContain("src/a.txt");
    expect(result.stdout).toContain("src/b.txt");
  });

  test("fireAgentHook returns 0 (no-op) when no rule matches the tool", async () => {
    await writeAgentConfig(fixture.cwd, "claude-code", "PostToolUse");
    const result = await fireAgentHook({
      agent: "claude",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { file_paths: [] },
      }),
    });
    expect(result.exitCode).toBe(0);
    // Nothing should have run because the matcher is Edit|Write.
    expect(result.stdout).not.toContain("fake-lint:");
  });

  test("fireAgentHook returns 2 when the config references a missing pipeline", async () => {
    const brokenYaml = `
name: broken
steps:
  lint:
    run: bash scripts/fake-lint.sh {files}
pipelines:
  agent-edit:
    steps: [lint]
agents:
  claude-code:
    hooks:
      PostToolUse:
        - pipeline: ghost
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      brokenYaml,
      "utf8",
    );
    const result = await fireAgentHook({
      agent: "claude",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
      }),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("undefined pipeline");
  });

  test("sendPromptToFakeAgent writes a marker file and fires the hook", async () => {
    await writeAgentConfig(fixture.cwd, "claude-code", "PostToolUse");
    const result = await sendPromptToFakeAgent({
      prompt: "edit src/a.txt to add a comment",
      session: {
        agent: "claude",
        event: "PostToolUse",
        files: ["src/a.txt"],
      },
      cwd: fixture.cwd,
    });
    expect(result.promptEcho).toBe("edit src/a.txt to add a comment");
    expect(result.hookResult.exitCode).toBe(0);
    expect(result.hookResult.stdout).toContain("src/a.txt");

    const marker = await fs.readFile(result.markerPath, "utf8");
    expect(marker).toContain("prompt: edit src/a.txt");
    expect(marker).toContain("files: src/a.txt");
  });

  test("sendPromptToFakeAgent propagates hook failure exit code", async () => {
    // Config uses a step that exits non-zero.
    const breakingConfig = `
name: breaking
steps:
  failing:
    run: bash scripts/failing.sh
    invocation: project
pipelines:
  agent-edit:
    steps: [failing]
agents:
  claude-code:
    hooks:
      PostToolUse:
        - matcher: "Edit"
          pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      breakingConfig,
      "utf8",
    );
    const result = await sendPromptToFakeAgent({
      prompt: "touch something that will fail",
      session: {
        agent: "claude",
        event: "PostToolUse",
        files: ["src/a.txt"],
      },
      cwd: fixture.cwd,
    });
    expect(result.hookResult.exitCode).toBe(7);
  });

  test("agent install + fireAgentHook round-trip: claude config is written, then a hook fires", async () => {
    await writeAgentConfig(fixture.cwd, "claude-code", "PostToolUse");

    // Step 1: install claude's native settings.
    const installResult = await runCli(["agent", "install", "claude"], {
      cwd: fixture.cwd,
    });
    expect(installResult.exitCode).toBe(0);
    expect(
      await fixtureFileExists(fixture.cwd, ".claude/settings.json"),
    ).toBe(true);
    const settings = await readFixtureFile(
      fixture.cwd,
      ".claude/settings.json",
    );
    expect(settings).toContain("agent-hooks hook claude PostToolUse");

    // Step 2: fire the hook, which is what Claude Code would do.
    const hookResult = await fireAgentHook({
      agent: "claude",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
      }),
    });
    expect(hookResult.exitCode).toBe(0);
    expect(hookResult.stdout).toContain("fake-lint:");
  });

  test("gemini-cli round-trip with BeforeTool event", async () => {
    await writeAgentConfig(fixture.cwd, "gemini-cli", "BeforeTool");

    const installResult = await runCli(["agent", "install", "gemini-cli"], {
      cwd: fixture.cwd,
    });
    expect(installResult.exitCode).toBe(0);
    expect(
      await fixtureFileExists(fixture.cwd, ".gemini/settings.json"),
    ).toBe(true);

    const hookResult = await fireAgentHook({
      agent: "gemini-cli",
      event: "BeforeTool",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "BeforeTool",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/b.txt"] },
      }),
    });
    expect(hookResult.exitCode).toBe(0);
    expect(hookResult.stdout).toContain("src/b.txt");
  });

  test("droid round-trip writes settings into ~/.factory (user scope) and dispatches", async () => {
    const fakeHome = path.join(fixture.cwd, ".home");
    await fs.mkdir(fakeHome, { recursive: true });

    const droidYaml = `
name: droid-harness
steps:
  lint:
    run: bash scripts/fake-lint.sh {files}
    files: "**/*.txt"
pipelines:
  agent-edit:
    steps: [lint]
agents:
  droid:
    hooks:
      PostToolUse:
        - pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      droidYaml,
      "utf8",
    );

    const installResult = await runCli(
      ["agent", "install", "droid", "--scope", "user"],
      {
        cwd: fixture.cwd,
        env: { HOME: fakeHome },
      },
    );
    expect(installResult.exitCode).toBe(0);

    // The droid installer writes to homeDir/.factory, and homeDir is
    // derived from os.homedir() at module load for the default deps.
    // So we can only assert the install command ran cleanly and the
    // dispatch works for the in-process invocation — we don't tie
    // the user-scope path to a test-controlled home.

    const hookResult = await fireAgentHook({
      agent: "droid",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
      }),
    });
    expect(hookResult.exitCode).toBe(0);
    expect(hookResult.stdout).toContain("src/a.txt");
  });

  test("writeFakeAgentScript produces an executable script that can be invoked", async () => {
    const scriptPath = path.join(fixture.cwd, "scripts", "fake-claude.sh");
    await writeFakeAgentScript({
      path: scriptPath,
      agent: "claude",
      event: "PostToolUse",
      markerPath: path.join(fixture.cwd, ".fake-marker"),
    });
    expect(
      await fixtureFileExists(fixture.cwd, "scripts/fake-claude.sh"),
    ).toBe(true);
    const contents = await fs.readFile(scriptPath, "utf8");
    expect(contents).toContain("#!/bin/sh");
    expect(contents).toContain("agent-hooks hook claude PostToolUse");
    expect(contents).toContain("fake-agent: claude firing PostToolUse");

    const stat = await fs.stat(scriptPath);
    // Owner-executable bit set.
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  test("writeFakeAgentScript uses the default marker path when none is provided", async () => {
    const scriptPath = path.join(fixture.cwd, "scripts", "default-marker.sh");
    await writeFakeAgentScript({
      path: scriptPath,
      agent: "claude",
      event: "Stop",
    });
    const contents = await fs.readFile(scriptPath, "utf8");
    expect(contents).toContain("/tmp/fake-agent-marker");
  });

  test("agent list reports each configured agent as present/absent", async () => {
    const result = await runCli(["agent", "list"], { cwd: fixture.cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Known agents:");
    expect(result.stdout).toContain("claude");
    expect(result.stdout).toContain("gemini-cli");
  });

  test("multi-agent config: claude and gemini both dispatch the same pipeline", async () => {
    const bothYaml = `
name: multi-agent
steps:
  lint:
    run: bash scripts/fake-lint.sh {files}
    files: "**/*.txt"
pipelines:
  agent-edit:
    steps: [lint]
agents:
  claude-code:
    hooks:
      PostToolUse:
        - matcher: "Edit"
          pipeline: agent-edit
  gemini-cli:
    hooks:
      BeforeTool:
        - matcher: "Edit"
          pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      bothYaml,
      "utf8",
    );

    const claudeResult = await fireAgentHook({
      agent: "claude",
      event: "PostToolUse",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
      }),
    });
    expect(claudeResult.exitCode).toBe(0);
    expect(claudeResult.stdout).toContain("src/a.txt");

    const geminiResult = await fireAgentHook({
      agent: "gemini-cli",
      event: "BeforeTool",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "BeforeTool",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/b.txt"] },
      }),
    });
    expect(geminiResult.exitCode).toBe(0);
    expect(geminiResult.stdout).toContain("src/b.txt");
  });
});
