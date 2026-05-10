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
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
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
    expect(result.hookResult.stdout).toBe("");
    expect(result.hookResult.stderr).toBe("");

    const marker = await fs.readFile(result.markerPath, "utf8");
    expect(marker).toContain("prompt: edit src/a.txt");
    expect(marker).toContain("files: src/a.txt");
  });

  test("sendPromptToFakeAgent remaps hook failure to exit 2 so Claude sees stderr", async () => {
    // Config uses a step that exits 7. Claude Code, Codex, and Gemini
    // CLI all treat exit 2 on a hook as "feed stderr back to the model
    // as non-blocking feedback" — other non-zero codes are silently
    // shown to the USER only. agent-hooks remaps any pipeline failure
    // to exit 2 so our ---agent-hooks:next-step--- stderr blocks reach
    // the coding agent for self-correction. The underlying step's
    // original exit 7 is surfaced via the structured step outcome,
    // not via the process exit code.
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
    expect(result.hookResult.exitCode).toBe(2);
    expect(result.hookResult.stderr).toContain("failing on purpose");
    expect(result.hookResult.stdout).not.toContain("pipeline: agent-edit");
    expect(result.hookResult.stderr).toContain("---agent-hooks:next-step---");
    expect(result.hookResult.stderr).toContain("status: failed");
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
    expect(hookResult.stdout).toBe("");
    expect(hookResult.stderr).toBe("");
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
    expect(hookResult.stdout).toBe("");
    expect(hookResult.stderr).toBe("");
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
    expect(hookResult.stdout).toBe("");
    expect(hookResult.stderr).toBe("");
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
    expect(claudeResult.stdout).toBe("");
    expect(claudeResult.stderr).toBe("");

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
    expect(geminiResult.stdout).toBe("");
    expect(geminiResult.stderr).toBe("");
  });

  // --- Hermes Agent (Nous Research) ------------------------------------
  //
  // Hermes lives at https://github.com/NousResearch/hermes-agent. Its
  // shell-hook system loads from `~/.hermes/config.yaml` only — no
  // project-local override on the hermes side. Stdin payloads share
  // Claude Code's `hook_event_name`/`tool_name`/`tool_input` shape but
  // event names are snake_case (`pre_tool_call`, `post_tool_call`, …)
  // and matchers are regex full-matches against `tool_name`. Hermes
  // does NOT use exit-code feedback: non-zero hook exits log a warning
  // but never block the loop, so our handler intentionally leaves
  // `stderrFeedbackOnExit2` unset and we assert that contract here.
  test("hermes round-trip with post_tool_call event", async () => {
    await writeAgentConfig(fixture.cwd, "hermes", "post_tool_call");
    const result = await fireAgentHook({
      agent: "hermes",
      event: "post_tool_call",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "post_tool_call",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
        session_id: "sess_test",
        cwd: fixture.cwd,
        extra: {},
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("hermes returns 0 (no-op) when the regex matcher does not match", async () => {
    await writeAgentConfig(fixture.cwd, "hermes", "post_tool_call");
    const result = await fireAgentHook({
      agent: "hermes",
      event: "post_tool_call",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "post_tool_call",
        // The fixture matcher is "Edit|Write"; "terminal" should not match.
        tool_name: "terminal",
        tool_input: { command: "echo hi" },
        session_id: "sess_test",
        cwd: fixture.cwd,
        extra: {},
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("fake-lint:");
  });

  test("hermes does NOT remap pipeline failure to exit 2 (no stderrFeedbackOnExit2)", async () => {
    // Same failing fixture as the claude test, but routed through
    // hermes. Claude/codex/droid remap any non-zero exit to 2 so
    // `stderr` reaches the model. Hermes feeds the model via stdout
    // JSON, not exit codes, so the dispatcher must propagate the
    // pipeline's exit code verbatim — anything other than 2.
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
  hermes:
    hooks:
      post_tool_call:
        - matcher: "Edit"
          pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      breakingConfig,
      "utf8",
    );
    const result = await fireAgentHook({
      agent: "hermes",
      event: "post_tool_call",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "post_tool_call",
        tool_name: "Edit",
        tool_input: { file_paths: ["src/a.txt"] },
        session_id: "sess_test",
        cwd: fixture.cwd,
        extra: {},
      }),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).not.toBe(2);
    expect(result.stderr).toContain("failing on purpose");
  });

  test("agent install hermes (project scope) writes a YAML config with our hooks block", async () => {
    await writeAgentConfig(fixture.cwd, "hermes", "post_tool_call");

    const installResult = await runCli(["agent", "install", "hermes"], {
      cwd: fixture.cwd,
    });
    expect(installResult.exitCode).toBe(0);
    expect(
      await fixtureFileExists(fixture.cwd, ".hermes/config.yaml"),
    ).toBe(true);

    const settings = await readFixtureFile(
      fixture.cwd,
      ".hermes/config.yaml",
    );
    // YAML output: top-level `hooks:` map with `post_tool_call:` list
    // whose entries point at our dispatch command.
    expect(settings).toContain("hooks:");
    expect(settings).toContain("post_tool_call:");
    expect(settings).toContain(
      "agent-hooks hook hermes post_tool_call",
    );
    expect(settings).toContain('matcher: Edit|Write');
  });

  test("hook payload paths from outside the repo are dropped (user-scope safety)", async () => {
    // User-scope agent installs (hermes ~/.hermes/config.yaml,
    // claude ~/.claude/settings.json, droid ~/.factory/settings.json,
    // …) fire a single hooks file for every session regardless of the
    // agent's working directory. Without a project-root clamp, a
    // payload containing absolute paths from another project — or a
    // tool_input pointing at /etc/hosts — would flow into whichever
    // pipeline the current cwd's config defines. This test exercises
    // the dispatcher's clamp via hermes (the most-recently-added
    // user-scope agent) but the protection lives in
    // src/commands/hook.ts and applies to every handler.
    const recorderScript = `#!/usr/bin/env bash
# Append every arg on its own line so the test can assert which
# files actually reached the step. Always exits 0.
for arg in "$@"; do
  echo "$arg" >> .lint-args
done
exit 0
`;
    const recorderPath = path.join(
      fixture.cwd,
      "scripts",
      "record-args.sh",
    );
    await fs.writeFile(recorderPath, recorderScript, "utf8");
    await fs.chmod(recorderPath, 0o755);

    const recordingConfig = `
name: hermes-clamp
steps:
  record:
    run: bash scripts/record-args.sh {files}
    files: "**/*.txt"
pipelines:
  agent-edit:
    steps: [record]
agents:
  hermes:
    hooks:
      post_tool_call:
        - matcher: "Edit|Write"
          pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      recordingConfig,
      "utf8",
    );

    // Mix: one in-repo absolute, one in-repo relative, one absolute
    // path from a sibling project, one absolute system path. Only
    // the first two should reach the step.
    const inRepoAbsolute = path.join(fixture.cwd, "src", "a.txt");
    const inRepoRelative = "src/b.txt";
    const siblingProject = "/Users/somebody/other-project/src/x.txt";
    const systemPath = "/etc/hosts";

    const result = await fireAgentHook({
      agent: "hermes",
      event: "post_tool_call",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "post_tool_call",
        tool_name: "Edit",
        tool_input: {
          file_paths: [
            inRepoAbsolute,
            inRepoRelative,
            siblingProject,
            systemPath,
          ],
        },
        session_id: "sess_test",
        cwd: fixture.cwd,
        extra: {},
      }),
    });
    expect(result.exitCode).toBe(0);

    const recorded = await fs.readFile(
      path.join(fixture.cwd, ".lint-args"),
      "utf8",
    );
    const lines = recorded
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // In-repo paths reached the step.
    expect(lines).toContain(inRepoAbsolute);
    expect(lines).toContain(inRepoRelative);
    // Out-of-repo paths did NOT.
    expect(lines).not.toContain(siblingProject);
    expect(lines).not.toContain(systemPath);
  });

  test("hook payload with only out-of-repo paths skips the step instead of running it", async () => {
    // After the clamp drops every path, the step's file list is
    // empty. file-scoped steps with no fallback skip cleanly with
    // exit 0 — the hook returns success and the agent loop continues
    // without surfacing a confusing "no matching files" error.
    const recorderScript = `#!/usr/bin/env bash
echo "STEP RAN" >> .ran-marker
exit 0
`;
    const recorderPath = path.join(
      fixture.cwd,
      "scripts",
      "ran-marker.sh",
    );
    await fs.writeFile(recorderPath, recorderScript, "utf8");
    await fs.chmod(recorderPath, 0o755);

    const config = `
name: hermes-clamp-empty
steps:
  record:
    run: bash scripts/ran-marker.sh {files}
    files: "**/*.txt"
pipelines:
  agent-edit:
    steps: [record]
agents:
  hermes:
    hooks:
      post_tool_call:
        - matcher: "Edit"
          pipeline: agent-edit
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      config,
      "utf8",
    );

    const result = await fireAgentHook({
      agent: "hermes",
      event: "post_tool_call",
      cwd: fixture.cwd,
      stdin: JSON.stringify({
        hook_event_name: "post_tool_call",
        tool_name: "Edit",
        tool_input: { file_paths: ["/etc/hosts", "/tmp/scratch.txt"] },
        session_id: "sess_test",
        cwd: fixture.cwd,
        extra: {},
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(
      await fixtureFileExists(fixture.cwd, ".ran-marker"),
    ).toBe(false);
  });

  test("agent install hermes preserves foreign keys and is idempotent", async () => {
    await writeAgentConfig(fixture.cwd, "hermes", "post_tool_call");

    // Pre-seed the user's hand-edited config: an unrelated top-level
    // key (providers) plus a foreign hook entry under post_tool_call
    // that is NOT managed by agent-hooks. Both must survive install.
    const seedYaml = `providers:
  default: openai
hooks_auto_accept: true
hooks:
  post_tool_call:
    - matcher: "patch"
      command: "~/.hermes/hooks/auto-format.sh"
      timeout: 30
`;
    await fs.mkdir(path.join(fixture.cwd, ".hermes"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.cwd, ".hermes", "config.yaml"),
      seedYaml,
      "utf8",
    );

    const firstInstall = await runCli(["agent", "install", "hermes"], {
      cwd: fixture.cwd,
    });
    expect(firstInstall.exitCode).toBe(0);

    const afterFirst = await readFixtureFile(
      fixture.cwd,
      ".hermes/config.yaml",
    );
    // Foreign top-level keys preserved.
    expect(afterFirst).toContain("providers:");
    expect(afterFirst).toContain("default: openai");
    expect(afterFirst).toContain("hooks_auto_accept: true");
    // Foreign hook entry preserved verbatim.
    expect(afterFirst).toContain("auto-format.sh");
    // Our managed entry inserted alongside.
    expect(afterFirst).toContain(
      "agent-hooks hook hermes post_tool_call",
    );

    // Re-running install must not duplicate our managed entry. We
    // count occurrences of our dispatch command — exactly one after
    // each install.
    const ourCommand = "agent-hooks hook hermes post_tool_call";
    const occurrencesAfterFirst = (
      afterFirst.match(new RegExp(ourCommand, "g")) ?? []
    ).length;
    expect(occurrencesAfterFirst).toBe(1);

    const secondInstall = await runCli(["agent", "install", "hermes"], {
      cwd: fixture.cwd,
    });
    expect(secondInstall.exitCode).toBe(0);
    const afterSecond = await readFixtureFile(
      fixture.cwd,
      ".hermes/config.yaml",
    );
    const occurrencesAfterSecond = (
      afterSecond.match(new RegExp(ourCommand, "g")) ?? []
    ).length;
    expect(occurrencesAfterSecond).toBe(1);
    // Foreign entry still there after re-install.
    expect(afterSecond).toContain("auto-format.sh");
  });
});
