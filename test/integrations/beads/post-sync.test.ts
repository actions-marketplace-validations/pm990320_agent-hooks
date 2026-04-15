import { describe, expect, test } from "bun:test";
import { runBeadsPostSync } from "../../../src/integrations/beads/post-sync.ts";
import type { ExecFn, ExecInput } from "../../../src/runners/step.ts";

interface ScriptStep {
  match: string;
  exit: number;
}

function scriptedExec(steps: readonly ScriptStep[]): {
  exec: ExecFn;
  calls: ExecInput[];
} {
  const calls: ExecInput[] = [];
  let idx = 0;
  const exec: ExecFn = (input) => {
    calls.push(input);
    const step = steps[idx++];
    if (!step) throw new Error(`unexpected exec call: ${input.command}`);
    if (!input.command.includes(step.match)) {
      throw new Error(
        `exec mismatch at step ${String(idx - 1)}: expected "${step.match}", got "${input.command}"`,
      );
    }
    return Promise.resolve({ exitCode: step.exit, durationMs: 1 });
  };
  return { exec, calls };
}

describe("runBeadsPostSync", () => {
  test("commits a follow-up change when git commit exits 0", async () => {
    const { exec, calls } = scriptedExec([
      { match: "bd sync", exit: 0 },
      { match: "git status --porcelain", exit: 0 },
      { match: "git add .beads/", exit: 0 },
      { match: "git commit", exit: 0 },
    ]);
    const result = await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "chore(beads): sync",
      agentMarker: "[claude]",
    });
    expect(result.status).toBe("committed");
    expect(calls[3]?.command).toContain("[claude]");
  });

  test("reports no-changes when git commit exits 1", async () => {
    const { exec } = scriptedExec([
      { match: "bd sync", exit: 0 },
      { match: "git status", exit: 0 },
      { match: "git add", exit: 0 },
      { match: "git commit", exit: 1 },
    ]);
    const result = await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "chore(beads): sync",
      agentMarker: "",
    });
    expect(result.status).toBe("no-changes");
  });

  test("returns sync-failed when bd sync errors", async () => {
    const { exec } = scriptedExec([{ match: "bd sync", exit: 2 }]);
    const result = await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "msg",
      agentMarker: "",
    });
    expect(result.status).toBe("sync-failed");
    expect(result.exitCode).toBe(2);
  });

  test("returns commit-failed when git add errors", async () => {
    const { exec } = scriptedExec([
      { match: "bd sync", exit: 0 },
      { match: "git status", exit: 0 },
      { match: "git add", exit: 4 },
    ]);
    const result = await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "msg",
      agentMarker: "",
    });
    expect(result.status).toBe("commit-failed");
    expect(result.exitCode).toBe(4);
  });

  test("returns commit-failed when git commit errors with code > 1", async () => {
    const { exec } = scriptedExec([
      { match: "bd sync", exit: 0 },
      { match: "git status", exit: 0 },
      { match: "git add", exit: 0 },
      { match: "git commit", exit: 3 },
    ]);
    const result = await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "msg",
      agentMarker: "",
    });
    expect(result.status).toBe("commit-failed");
    expect(result.exitCode).toBe(3);
  });

  test("omits agent marker when empty string", async () => {
    const { exec, calls } = scriptedExec([
      { match: "bd sync", exit: 0 },
      { match: "git status", exit: 0 },
      { match: "git add", exit: 0 },
      { match: "git commit", exit: 0 },
    ]);
    await runBeadsPostSync({
      cwd: "/repo",
      exec,
      commitMessage: "msg",
      agentMarker: "",
    });
    expect(calls[3]?.command).not.toContain("[");
  });
});
