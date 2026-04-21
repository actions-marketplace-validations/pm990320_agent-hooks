import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { runCli } from "./support/cli.ts";
import { buildClaudeInput } from "./support/claude-input.ts";
import { copyFixture, stageFile, type Fixture } from "./support/fixture.ts";

describe("monorepo lifecycle", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await copyFixture("monorepo-basic");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("run lint --all from repo root runs root plus every workspace target", async () => {
    const result = await runCli(["run", "lint", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROOT cwd=");
    expect(result.stdout).toContain("shared/root.txt");
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).toContain("files=src/a.txt");
    expect(result.stdout).toContain("SERVICE_B_LINT cwd=");
    expect(result.stdout).toContain("files=src/b.txt");
  });

  test("shortcut lint routes affected files to the owning workspace", async () => {
    const result = await runCli(
      ["lint", "--files", "services/service-a/src/a.txt"],
      { cwd: fixture.cwd },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).toContain("files=src/a.txt");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
    expect(result.stdout).not.toContain("ROOT cwd=");
  });

  test("ci from inside a workspace still runs whole-monorepo ci", async () => {
    const result = await runCli(["ci", "--all"], {
      cwd: path.join(fixture.cwd, "services", "service-a"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROOT cwd=");
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).toContain("SERVICE_B_LINT cwd=");
  });

  test("workspace:target syntax narrows run to one workspace", async () => {
    const result = await runCli(["run", "services/service-a:lint", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
    expect(result.stdout).not.toContain("ROOT cwd=");
  });

  test("--workspace narrows run to one workspace by basename", async () => {
    const result = await runCli(
      ["run", "lint", "--workspace", "service-b", "--all"],
      { cwd: fixture.cwd },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SERVICE_B_LINT cwd=");
    expect(result.stdout).not.toContain("SERVICE_A_LINT");
    expect(result.stdout).not.toContain("ROOT cwd=");
  });

  test("missing targets in other workspaces are skipped silently", async () => {
    const result = await runCli(["run", "tidy", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SERVICE_A_TIDY cwd=");
    expect(result.stderr).not.toContain("unknown pipeline or step");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
  });

  test("fix supports monorepo routing and selector syntax", async () => {
    const result = await runCli(
      ["fix", "lint", "--workspace", "service-a", "--all"],
      {
        cwd: fixture.cwd,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SERVICE_A_FIX cwd=");
    expect(result.stdout).toContain("files=src/a.txt");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
  });

  test("git hooks fan out to root plus each affected workspace", async () => {
    await stageFile(fixture.cwd, "services/service-a/src/a.txt");
    await stageFile(fixture.cwd, "services/service-b/src/b.txt");

    const result = await runCli(["hook", "git", "pre-commit"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROOT_PRE_COMMIT cwd=");
    expect(result.stdout).toContain("services/service-a/src/a.txt");
    expect(result.stdout).toContain("services/service-b/src/b.txt");
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).toContain("files=src/a.txt");
    expect(result.stdout).toContain("SERVICE_B_LINT cwd=");
    expect(result.stdout).toContain("files=src/b.txt");
  });

  test("git hook subdir invocation still coordinates through the monorepo root", async () => {
    await stageFile(fixture.cwd, "services/service-a/src/a.txt");

    const result = await runCli(["hook", "git", "pre-commit"], {
      cwd: path.join(fixture.cwd, "services", "service-a"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROOT_PRE_COMMIT cwd=");
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
  });

  test("agent hooks fan out to root and matching workspaces, skipping others silently", async () => {
    const result = await runCli(["hook", "claude", "PostToolUse"], {
      cwd: fixture.cwd,
      stdin: buildClaudeInput({
        toolName: "Edit",
        files: [
          "services/service-a/src/a.txt",
          "services/service-b/src/b.txt",
        ],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ROOT_AGENT_EDIT cwd=");
    expect(result.stdout).toContain("services/service-a/src/a.txt");
    expect(result.stdout).toContain("services/service-b/src/b.txt");
    expect(result.stdout).toContain("SERVICE_A_LINT cwd=");
    expect(result.stdout).toContain("files=src/a.txt");
    expect(result.stdout).not.toContain("SERVICE_B_LINT");
    expect(result.stderr).not.toContain("no rule configured");
  });
});
