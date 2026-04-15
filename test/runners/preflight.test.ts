import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StepSchema, type Step } from "../../src/config/schema.ts";
import {
  defaultPreflightResolver,
  evaluatePreflight,
  resolvePreflightPolicy,
  type PreflightFs,
  type PreflightResolver,
} from "../../src/runners/preflight.ts";

function step(overrides: unknown): Step {
  return StepSchema.parse({
    run: "echo",
    ...(overrides as Record<string, unknown>),
  });
}

function memResolver(opts: {
  commands?: Set<string>;
  envs?: Record<string, string>;
  files?: Set<string>;
}): PreflightResolver {
  const cmds = opts.commands ?? new Set<string>();
  const envs = opts.envs ?? {};
  const files = opts.files ?? new Set<string>();
  const memFs: PreflightFs = {
    exists: (p) => Promise.resolve(files.has(p)),
  };
  return {
    whichCommand: (name) =>
      Promise.resolve(cmds.has(name) ? `/usr/bin/${name}` : null),
    getEnv: (name) => envs[name] ?? null,
    fs: memFs,
  };
}

describe("evaluatePreflight", () => {
  test("returns ok for a step with no requires", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [] }),
      "/repo",
      memResolver({}),
    );
    expect(decision.ok).toBe(true);
    expect(decision.failures).toEqual([]);
  });

  test("command requirement passes when on PATH", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ command: "eslint" }] }),
      "/repo",
      memResolver({ commands: new Set(["eslint"]) }),
    );
    expect(decision.ok).toBe(true);
  });

  test("command requirement fails when missing from PATH", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ command: "eslint" }] }),
      "/repo",
      memResolver({}),
    );
    expect(decision.ok).toBe(false);
    expect(decision.failures[0]?.reason).toContain("command not on PATH");
  });

  test("path requirement uses cwd-relative path", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ path: "node_modules/.bin" }] }),
      "/repo",
      memResolver({ files: new Set(["/repo/node_modules/.bin"]) }),
    );
    expect(decision.ok).toBe(true);
  });

  test("absolute path requirement passes through unchanged", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ path: "/etc/hosts" }] }),
      "/repo",
      memResolver({ files: new Set(["/etc/hosts"]) }),
    );
    expect(decision.ok).toBe(true);
  });

  test("path requirement reports missing", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ path: "node_modules/.bin" }] }),
      "/repo",
      memResolver({}),
    );
    expect(decision.failures[0]?.reason).toContain(
      "path missing: node_modules/.bin",
    );
  });

  test("file requirement variant", async () => {
    const decisionMissing = await evaluatePreflight(
      step({ requires: [{ file: ".eslintrc.json" }] }),
      "/repo",
      memResolver({}),
    );
    expect(decisionMissing.failures[0]?.reason).toContain("file missing");

    const decisionPresent = await evaluatePreflight(
      step({ requires: [{ file: ".eslintrc.json" }] }),
      "/repo",
      memResolver({ files: new Set(["/repo/.eslintrc.json"]) }),
    );
    expect(decisionPresent.ok).toBe(true);
  });

  test("absolute file requirement", async () => {
    const decision = await evaluatePreflight(
      step({ requires: [{ file: "/etc/hosts" }] }),
      "/repo",
      memResolver({ files: new Set(["/etc/hosts"]) }),
    );
    expect(decision.ok).toBe(true);
  });

  test("env requirement passes when set, fails when missing", async () => {
    const decisionMissing = await evaluatePreflight(
      step({ requires: [{ env: "NODE_ENV" }] }),
      "/repo",
      memResolver({}),
    );
    expect(decisionMissing.failures[0]?.reason).toContain("env var unset");

    const decisionPresent = await evaluatePreflight(
      step({ requires: [{ env: "NODE_ENV" }] }),
      "/repo",
      memResolver({ envs: { NODE_ENV: "test" } }),
    );
    expect(decisionPresent.ok).toBe(true);
  });

  test("node-modules requirement", async () => {
    const decisionPresent = await evaluatePreflight(
      step({ requires: [{ "node-modules": true }] }),
      "/repo",
      memResolver({ files: new Set(["/repo/node_modules"]) }),
    );
    expect(decisionPresent.ok).toBe(true);

    const decisionMissing = await evaluatePreflight(
      step({ requires: [{ "node-modules": true }] }),
      "/repo",
      memResolver({}),
    );
    expect(decisionMissing.failures[0]?.reason).toContain("node_modules/");
  });

  test("collects multiple failures in order", async () => {
    const decision = await evaluatePreflight(
      step({
        requires: [
          { command: "eslint" },
          { env: "NODE_ENV" },
          { path: "node_modules/.bin" },
        ],
      }),
      "/repo",
      memResolver({}),
    );
    expect(decision.failures.length).toBe(3);
  });
});

describe("resolvePreflightPolicy", () => {
  test("explicit step on-missing wins regardless of context", () => {
    expect(
      resolvePreflightPolicy(
        step({ "on-missing": "fail" }),
        "git-hook",
      ),
    ).toBe("fail");
    expect(
      resolvePreflightPolicy(
        step({ "on-missing": "skip" }),
        "manual",
      ),
    ).toBe("skip");
  });

  test("git-hook context defaults to warn-skip", () => {
    expect(resolvePreflightPolicy(step({}), "git-hook")).toBe("warn-skip");
  });

  test("agent-hook context defaults to warn-skip", () => {
    expect(resolvePreflightPolicy(step({}), "agent-hook")).toBe("warn-skip");
  });

  test("manual context defaults to fail", () => {
    expect(resolvePreflightPolicy(step({}), "manual")).toBe("fail");
  });

  test("ci context defaults to fail", () => {
    expect(resolvePreflightPolicy(step({}), "ci")).toBe("fail");
  });
});

describe("defaultPreflightResolver", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-preflight-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("getEnv reads real process env", () => {
    const original = process.env["AGENT_HOOKS_TEST_VAR"];
    process.env["AGENT_HOOKS_TEST_VAR"] = "hello";
    try {
      expect(defaultPreflightResolver.getEnv("AGENT_HOOKS_TEST_VAR")).toBe(
        "hello",
      );
    } finally {
      if (original === undefined) {
        delete process.env["AGENT_HOOKS_TEST_VAR"];
      } else {
        process.env["AGENT_HOOKS_TEST_VAR"] = original;
      }
    }
    expect(
      defaultPreflightResolver.getEnv("AGENT_HOOKS_DEFINITELY_NOT_SET"),
    ).toBeNull();
  });

  test("fs.exists returns true for real paths", async () => {
    const file = path.join(tmp, "marker");
    await fs.writeFile(file, "x", "utf8");
    expect(await defaultPreflightResolver.fs.exists(file)).toBe(true);
    expect(
      await defaultPreflightResolver.fs.exists(path.join(tmp, "missing")),
    ).toBe(false);
  });

  test("whichCommand returns null for nonsense, finds real ones", async () => {
    expect(
      await defaultPreflightResolver.whichCommand(
        "agent-hooks-definitely-not-a-real-binary",
      ),
    ).toBeNull();
    // `git` should be on the test runner's PATH.
    const gitPath = await defaultPreflightResolver.whichCommand("git");
    expect(gitPath).not.toBeNull();
  });

  test("whichCommand handles empty PATH", async () => {
    const original = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      expect(
        await defaultPreflightResolver.whichCommand("git"),
      ).toBeNull();
    } finally {
      process.env["PATH"] = original;
    }
  });
});
