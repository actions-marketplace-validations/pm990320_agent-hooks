import { describe, expect, test } from "bun:test";
import { ExitError, buildProgram, run, runProgram } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

function silentProgram() {
  const program = buildProgram();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  return program;
}

describe("buildProgram", () => {
  test("sets the program name", () => {
    expect(buildProgram().name()).toBe("agent-hooks");
  });

  test("exposes the package version", () => {
    expect(buildProgram().version()).toBe(VERSION);
  });

  test("has a non-empty description", () => {
    expect(buildProgram().description().length).toBeGreaterThan(0);
  });
});

describe("runProgram", () => {
  test("returns 0 when a registered command action runs to completion", async () => {
    const program = silentProgram();
    program.command("noop").action(() => {});
    const code = await runProgram(program, ["noop"]);
    expect(code).toBe(0);
  });

  test("returns commander's exit code for a CommanderError (unknown option)", async () => {
    const code = await runProgram(silentProgram(), ["--definitely-unknown"]);
    expect(code).toBe(1);
  });

  test("returns 1 when an action throws a non-CommanderError", async () => {
    const program = silentProgram();
    program.command("boom").action(() => {
      throw new Error("boom");
    });
    const code = await runProgram(program, ["boom"]);
    expect(code).toBe(1);
  });

  test("returns the ExitError's exit code when an action throws one", async () => {
    const program = silentProgram();
    program.command("bail").action(() => {
      throw new ExitError(42);
    });
    const code = await runProgram(program, ["bail"]);
    expect(code).toBe(42);
  });
});

describe("ExitError", () => {
  test("captures the exit code and sets a readable name", () => {
    const err = new ExitError(3);
    expect(err.exitCode).toBe(3);
    expect(err.name).toBe("ExitError");
    expect(err.message).toContain("3");
  });
});

describe("run", () => {
  test("delegates to runProgram with a fresh program (--help exits 0)", async () => {
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const code = await run(["--help"]);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    }
  });
});
