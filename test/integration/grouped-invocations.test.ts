import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "./support/cli.ts";
import { copyFixture, type Fixture } from "./support/fixture.ts";

describe("grouped invocation modes", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await copyFixture("grouped-modes");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  test("per-directory and per-marker-dir dedupe grouped targets", async () => {
    const result = await runCli(["run", "grouped", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TF cwd=");
    expect(result.stdout).toContain("dir=infra/dev");
    expect(result.stdout).toContain("infra/dev/main.tf infra/dev/vars.tf");
    expect(result.stdout).toContain("dir=infra/prod");
    expect(result.stdout).toContain("HELM cwd=");
    expect(result.stdout).toContain("dir=charts/app");
    expect(result.stdout).toContain("charts/app/templates/deploy.yaml");
    expect(result.stdout).toContain("charts/app/charts/subchart/templates/sub.yaml");
    expect(result.stdout).not.toContain("dir=charts/app/charts/subchart");
  });

  test("grouped invocation modes compose with pipeline.parallel", async () => {
    const result = await runCli(["run", "grouped-parallel", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ terraform-validate");
    expect(result.stdout).toContain("✓ helm-lint");
    expect(result.stdout).toContain("TF cwd=");
    expect(result.stdout).toContain("HELM cwd=");
  });

  test("repo-root template aliases resolve from nested invocation cwd", async () => {
    const nestedCwd = path.join(fixture.cwd, "infra", "dev");
    const realRoot = await fs.realpath(fixture.cwd);
    const result = await runCli(["run", "repo-root", "--all"], {
      cwd: nestedCwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `repo_root=${realRoot} git_root=${realRoot} repo_root_alias=${realRoot}`,
    );
  });

  test("on-failure warn makes informational grouped steps non-fatal", async () => {
    const result = await runCli(["run", "info", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("INFO dir=infra/dev");
    expect(result.stdout).toContain("warned (exit 7)");
  });

  test("requires.file with on-missing skip skips the step cleanly", async () => {
    const result = await runCli(["run", "guard", "--all"], {
      cwd: fixture.cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("⚠ missing-config-guard");
    expect(result.stdout).toContain("SKIPPED (missing: file missing: .tflint.hcl)");
    expect(result.stdout).not.toContain("GUARD");
  });
});
