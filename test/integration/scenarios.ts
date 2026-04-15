import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { runCli } from "./support/cli.ts";
import {
  copyFixture,
  fixtureFileExists,
  stageFile,
  type Fixture,
} from "./support/fixture.ts";

export interface FixtureScenarioOptions {
  /** Name of the fixture under test/fixtures/. */
  readonly fixtureName: string;
  /** A step whose scripts/ contains a `fake-lint.sh` + `fake-test.sh`. */
  readonly lintStep: string;
  readonly testStep: string;
  /** A file path under src/ for --files tests. */
  readonly sampleFile: string;
}

/**
 * Parameterized lifecycle scenarios that every language fixture should
 * satisfy. Call `runFixtureScenarios("bun-ts", ...)` from a per-fixture
 * test file. Each scenario runs in its own fresh copy of the fixture so
 * mutations don't leak.
 */
export function runFixtureScenarios(options: FixtureScenarioOptions): void {
  describe(`${options.fixtureName} lifecycle`, () => {
    let fixture: Fixture;

    beforeEach(async () => {
      fixture = await copyFixture(options.fixtureName);
    });

    afterEach(async () => {
      await fixture.cleanup();
    });

    test("ci --all runs the full pipeline successfully", async () => {
      const result = await runCli(["ci", "--all"], { cwd: fixture.cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pipeline: ci");
      expect(result.stdout).toContain(`✓ ${options.lintStep}`);
      expect(result.stdout).toContain(`✓ ${options.testStep}`);
    });

    test(`run ${options.lintStep} --files <path> passes only that path`, async () => {
      const result = await runCli(
        ["run", options.lintStep, "--files", options.sampleFile],
        { cwd: fixture.cwd },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(options.sampleFile);
    });

    test(`run ${options.lintStep} --staged after stageFile picks up the staged path`, async () => {
      await stageFile(fixture.cwd, options.sampleFile);
      const result = await runCli(["run", options.lintStep, "--staged"], {
        cwd: fixture.cwd,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(options.sampleFile);
    });

    test("doctor validates the fixture config", async () => {
      const result = await runCli(["doctor"], { cwd: fixture.cwd });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Config loaded");
    });

    test("install writes managed git hooks", async () => {
      const result = await runCli(["install"], { cwd: fixture.cwd });
      expect(result.exitCode).toBe(0);
      expect(
        await fixtureFileExists(fixture.cwd, ".git/hooks/pre-commit"),
      ).toBe(true);
      const stub = await fs.readFile(
        path.join(fixture.cwd, ".git/hooks/pre-commit"),
        "utf8",
      );
      expect(stub).toContain("hook git pre-commit");
    });

    test("install --if-missing is silent after the first install", async () => {
      await runCli(["install"], { cwd: fixture.cwd });
      const result = await runCli(["install", "--if-missing"], {
        cwd: fixture.cwd,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    test("hook git pre-commit runs the configured pre-commit pipeline", async () => {
      await runCli(["install"], { cwd: fixture.cwd });
      await stageFile(fixture.cwd, options.sampleFile);
      const result = await runCli(["hook", "git", "pre-commit"], {
        cwd: fixture.cwd,
      });
      expect(result.exitCode).toBe(0);
    });
  });
}
