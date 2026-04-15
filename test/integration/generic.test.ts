import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildClaudeInput } from "./support/claude-input.ts";
import { runCli } from "./support/cli.ts";
import {
  copyFixture,
  fixtureFileExists,
  readFixtureFile,
  stageFile,
  type Fixture,
} from "./support/fixture.ts";

describe("generic fixture lifecycle", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await copyFixture("generic");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("harness copies the fixture, runs git init, and scripts are executable", async () => {
    expect(await fixtureFileExists(fixture.cwd, ".config/agent-hooks.yml")).toBe(
      true,
    );
    expect(await fixtureFileExists(fixture.cwd, "scripts/fake-lint.sh")).toBe(
      true,
    );
    expect(await fixtureFileExists(fixture.cwd, ".git")).toBe(true);
    const content = await readFixtureFile(
      fixture.cwd,
      ".config/agent-hooks.yml",
    );
    expect(content).toContain("generic-fixture");
  });

  test("agent-hooks schema prints JSON to stdout", async () => {
    const result = await runCli(["schema"], { cwd: fixture.cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("https://json-schema.org/draft/2020-12");
  });

  test("agent-hooks doctor validates the fixture config", async () => {
    const result = await runCli(["doctor"], { cwd: fixture.cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Config loaded");
    expect(result.stdout).toContain("3 steps, 2 pipelines");
  });

  test("ci --all runs both pipeline steps with fake scripts", async () => {
    const result = await runCli(["ci", "--all"], { cwd: fixture.cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pipeline: ci");
    expect(result.stdout).toContain("✓ lint");
    expect(result.stdout).toContain("✓ typecheck");
    expect(result.stdout).toContain("fake-lint:");
    expect(result.stdout).toContain("fake-typecheck:");
  });

  test("run lint --all targets src/**/*.txt and handles spaces in filenames", async () => {
    const result = await runCli(["run", "lint", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/a.txt");
    expect(result.stdout).toContain("src/b.txt");
    expect(result.stdout).toContain("has space.txt");
  });

  test("run broken pipeline surfaces the failing step exit code", async () => {
    const result = await runCli(["run", "broken", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("✗ failing");
    expect(result.stdout).toContain("failed (exit 7)");
  });

  test("run lint --files targets only explicit paths", async () => {
    const result = await runCli(
      ["run", "lint", "--files", "src/a.txt"],
      { cwd: fixture.cwd },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/a.txt");
    expect(result.stdout).not.toContain("src/b.txt");
  });

  test("run lint --staged picks up staged files after editing", async () => {
    await stageFile(fixture.cwd, "src/a.txt");
    const result = await runCli(["run", "lint", "--staged"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("src/a.txt");
  });

  test("GITHUB_ACTIONS=true uses the GH reporter with group markers", async () => {
    const result = await runCli(["ci", "--all"], {
      cwd: fixture.cwd,
      env: { GITHUB_ACTIONS: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::group::agent-hooks pipeline: ci");
    expect(result.stdout).toContain("::group::lint");
    expect(result.stdout).toContain("::endgroup::");
  });

  test("ci --all inside GH Actions reporter emits ::error:: on failure", async () => {
    const result = await runCli(["run", "broken", "--all"], {
      cwd: fixture.cwd,
      env: { GITHUB_ACTIONS: "true" },
    });
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("::error title=failing");
  });

  test("doctor exits 2 on a config referencing an undefined step", async () => {
    const broken = `
name: broken
steps:
  lint:
    run: bash scripts/fake-lint.sh {files}
pipelines:
  ci:
    steps: [lint, ghost]
`;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      broken,
      "utf8",
    );
    const result = await runCli(["doctor"], { cwd: fixture.cwd });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("undefined step");
  });

  test("buildClaudeInput produces a JSON payload with the expected fields", () => {
    const input = buildClaudeInput({
      toolName: "Edit",
      files: ["src/a.txt", "src/b.txt"],
    });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    expect(parsed["hook_event_name"]).toBe("PostToolUse");
    expect(parsed["tool_name"]).toBe("Edit");
    const toolInput = parsed["tool_input"] as Record<string, unknown>;
    expect(toolInput["file_path"]).toBe("src/a.txt");
    expect(toolInput["file_paths"]).toEqual(["src/a.txt", "src/b.txt"]);
  });

  test("buildClaudeInput with empty files leaves file_path empty", () => {
    const input = buildClaudeInput({ toolName: "Stop", files: [] });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const toolInput = parsed["tool_input"] as Record<string, unknown>;
    expect(toolInput["file_path"]).toBe("");
  });

  test("run --all picks up untracked-but-not-ignored files", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    // Fixture init commits everything, so this file is untracked.
    await fs.writeFile(
      path.join(fixture.cwd, "scripts", "untracked.sh"),
      "#!/usr/bin/env bash\necho untracked-hi\n",
      "utf8",
    );
    // Step scoped to **/*.sh, per-file, so each matched file echoes once.
    const cfg = `
name: generic-fixture
steps:
  sh-lint:
    run: bash scripts/fake-lint.sh {file}
    files: "**/*.sh"
    invocation: per-file
pipelines:
  sh-ci:
    steps: [sh-lint]
`;
    await fs.writeFile(
      path.join(fixture.cwd, ".config", "agent-hooks.yml"),
      cfg,
      "utf8",
    );
    const result = await runCli(["run", "sh-ci", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("skipped (no matching files)");
    expect(result.stdout).toContain("scripts/untracked.sh");
  });

  test(
    "timeout-ms terminates a hung step and reports timedOut",
    async () => {
      // Replace the fixture config with a single step that sleeps for
      // 30s and a 250ms timeout. The runner should SIGTERM/KILL it,
      // return exit 124, and surface the time-out reason in stdout.
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cfg = `
name: timeout-test
steps:
  hang:
    run: sleep 30
    invocation: project
    timeout-ms: 250
pipelines:
  ci:
    steps: [hang]
`;
      await fs.writeFile(
        path.join(fixture.cwd, ".config", "agent-hooks.yml"),
        cfg,
        "utf8",
      );
      const begin = Date.now();
      const result = await runCli(["run", "ci", "--all"], { cwd: fixture.cwd });
      const elapsed = Date.now() - begin;
      expect(result.exitCode).not.toBe(0);
      // 250ms timeout + ~1s SIGKILL escalation + Bun startup overhead.
      // 10s upper bound is generous; the step would otherwise run 30s.
      expect(elapsed).toBeLessThan(10_000);
      // Conventional GNU `timeout` exit code.
      expect(result.stdout).toContain("hang");
      expect(result.stdout).toContain("failed (exit 124)");
    },
    // Bun test's per-test default is 5s. The SIGTERM→SIGKILL escalation
    // plus process spawn overhead on slower CI runners can push real
    // elapsed time past that, so give this test its own 15s window.
    15_000,
  );

  test("invocation from a subdir re-anchors at the git root, not the subdir", async () => {
    // Without the gitRoot re-anchor, `git ls-files` from a subdir
    // would only see paths under the subdir and silently miss the
    // rest of the repo. Pin the fix here so it can't regress.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const subdir = path.join(fixture.cwd, "deep", "nested");
    await fs.mkdir(subdir, { recursive: true });

    const result = await runCli(["run", "lint", "--all"], { cwd: subdir });
    expect(result.exitCode).toBe(0);
    // The fixture has src/a.txt, src/b.txt, src/has space.txt at the
    // repo root. From the nested subdir these would be invisible if
    // we hadn't re-anchored.
    expect(result.stdout).toContain("src/a.txt");
    expect(result.stdout).toContain("src/b.txt");
  });

  test("CLI survives a downstream pipe close (EPIPE) without crashing", async () => {
    // Pin Bun's graceful EPIPE behavior. `agent-hooks schema` prints a
    // multi-KB JSON Schema; piping to `head -c 1` forces the consumer
    // to close the pipe after one byte. Anti-regression: if Bun ever
    // changes EPIPE behavior, this test will fail and we'll need to
    // install an explicit handler in src/index.ts.
    const path = await import("node:path");
    const cliEntry = path.join(
      import.meta.dir,
      "..",
      "..",
      "src",
      "index.ts",
    );
    const proc = Bun.spawn({
      cmd: ["sh", "-c", `bun ${cliEntry} schema | head -c 1`],
      cwd: fixture.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    // Conventional shell exit for a pipe that succeeded on its side
    // before the consumer closed: 0. We assert "didn't crash" — exit
    // 0 OR conventional 141 (SIGPIPE = 128 + 13) are both fine.
    expect(exitCode === 0 || exitCode === 141).toBe(true);
    expect(stdout.length).toBeGreaterThan(0);
    // No JS error noise on stderr.
    expect(stderr).not.toContain("EPIPE");
    expect(stderr).not.toContain("Uncaught");
  });

  test("buildClaudeInput honors hookEventName override", () => {
    const input = buildClaudeInput({
      toolName: "Write",
      files: ["x.ts"],
      hookEventName: "PreToolUse",
    });
    const parsed = JSON.parse(input) as Record<string, unknown>;
    expect(parsed["hook_event_name"]).toBe("PreToolUse");
  });
});
