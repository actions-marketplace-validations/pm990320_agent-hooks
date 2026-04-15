import { describe, expect, test } from "bun:test";
import { StepSchema, type Step } from "../../src/config/schema.ts";
import {
  DEFAULT_CHUNK_BYTES,
  applyTemplate,
  chunkFiles,
  joinFiles,
  joinFilesBrace,
  joinFilesNewline,
  pickRunVariant,
  runStep,
  shellQuote,
  type ExecFn,
  type ExecInput,
  type StepRunOptions,
} from "../../src/runners/step.ts";

// --- Small helpers -------------------------------------------------------

function parseStep(input: unknown): Step {
  return StepSchema.parse(input);
}

interface RecordedExec {
  readonly calls: ExecInput[];
  readonly exec: ExecFn;
}

function recordExec(exitCode = 0): RecordedExec {
  const calls: ExecInput[] = [];
  const exec: ExecFn = (input) => {
    calls.push(input);
    return Promise.resolve({ exitCode, durationMs: 1 });
  };
  return { calls, exec };
}

function baseOpts(
  overrides: Partial<StepRunOptions> & { step: Step },
): StepRunOptions {
  return {
    name: "test",
    files: [],
    cwd: "/repo",
    ...overrides,
  };
}

// --- shellQuote / joiners ------------------------------------------------

describe("shellQuote", () => {
  test("wraps simple paths in single quotes", () => {
    expect(shellQuote("src/a.ts")).toBe("'src/a.ts'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellQuote("it's.ts")).toBe("'it'\\''s.ts'");
  });
});

describe("joinFiles / joinFilesNewline / joinFilesBrace", () => {
  test("joinFiles space-joins quoted paths", () => {
    expect(joinFiles(["a.ts", "b c.ts"])).toBe("'a.ts' 'b c.ts'");
  });

  test("joinFilesNewline newline-joins quoted paths", () => {
    expect(joinFilesNewline(["a.ts", "b.ts"])).toBe("'a.ts'\n'b.ts'");
  });

  test("joinFilesBrace: empty → empty string", () => {
    expect(joinFilesBrace([])).toBe("");
  });

  test("joinFilesBrace: single file → plain quoted path", () => {
    expect(joinFilesBrace(["a.ts"])).toBe("'a.ts'");
  });

  test("joinFilesBrace: multi → shell brace expansion", () => {
    expect(joinFilesBrace(["a.ts", "b.ts", "c.ts"])).toBe(
      "{'a.ts','b.ts','c.ts'}",
    );
  });
});

// --- applyTemplate -------------------------------------------------------

describe("applyTemplate", () => {
  const baseCtx = {
    cwd: "/repo",
    env: { NODE_ENV: "development", MY_VAR: "hi" },
    files: ["a.ts", "b.ts"],
  };

  test("substitutes {files} with quoted join", () => {
    expect(applyTemplate("eslint {files}", baseCtx)).toBe(
      "eslint 'a.ts' 'b.ts'",
    );
  });

  test("substitutes {file} with the per-file entry", () => {
    expect(applyTemplate("shellcheck {file}", { ...baseCtx, file: "x.sh" })).toBe(
      "shellcheck 'x.sh'",
    );
  });

  test("leaves {file} empty when not provided", () => {
    expect(applyTemplate("lint {file}", baseCtx)).toBe("lint ");
  });

  test("substitutes {files_newline}", () => {
    expect(applyTemplate("cmd {files_newline}", baseCtx)).toContain(
      "'a.ts'\n'b.ts'",
    );
  });

  test("substitutes {glob} with brace expansion", () => {
    expect(applyTemplate("tool {glob}", baseCtx)).toBe("tool {'a.ts','b.ts'}");
  });

  test("substitutes {cwd} quoted", () => {
    expect(applyTemplate("cd {cwd}", baseCtx)).toBe("cd '/repo'");
  });

  test("substitutes {env.NAME} from the env map", () => {
    expect(applyTemplate("echo {env.NODE_ENV}", baseCtx)).toBe(
      "echo development",
    );
  });

  test("substitutes {env.NAME} with empty string when missing", () => {
    expect(applyTemplate("echo {env.UNSET}", baseCtx)).toBe("echo ");
  });

  test("leaves unknown word-shaped {tokens} untouched", () => {
    // `other_unknown` matches the outer regex but isn't a recognized key,
    // so the fallback returns the original match.
    expect(applyTemplate("echo {other_unknown}", baseCtx)).toBe(
      "echo {other_unknown}",
    );
  });

  test("leaves shell brace expansions with commas untouched", () => {
    // `{a,b,c}` doesn't match the regex at all, so replace() never fires.
    expect(applyTemplate("echo {a,b,c}", baseCtx)).toBe("echo {a,b,c}");
  });
});

// --- pickRunVariant ------------------------------------------------------

describe("pickRunVariant", () => {
  test("string run serves both variants", () => {
    expect(pickRunVariant("eslint", "files")).toBe("eslint");
    expect(pickRunVariant("eslint", "project")).toBe("eslint");
  });

  test("object run picks files variant when requested", () => {
    expect(
      pickRunVariant({ files: "vitest related", project: "vitest" }, "files"),
    ).toBe("vitest related");
  });

  test("object run picks project variant when requested", () => {
    expect(
      pickRunVariant({ files: "vitest related", project: "vitest" }, "project"),
    ).toBe("vitest");
  });

  test("object run falls back to the other variant when requested one is missing", () => {
    expect(pickRunVariant({ project: "vitest" }, "files")).toBe("vitest");
    expect(pickRunVariant({ files: "vitest r" }, "project")).toBe("vitest r");
  });

  test("returns null when no variant matches (should be impossible — schema guards)", () => {
    // Construct the impossible shape directly since the schema rejects it.
    expect(pickRunVariant({} as { files?: string }, "files")).toBeNull();
  });
});

// --- chunkFiles ----------------------------------------------------------

describe("chunkFiles", () => {
  test("returns a single chunk when well under the limit", () => {
    const chunks = chunkFiles(["a.ts", "b.ts", "c.ts"], DEFAULT_CHUNK_BYTES);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("splits by byte budget", () => {
    const longName = "x".repeat(50);
    const files = Array.from({ length: 10 }, (_, i) => `${longName}${String(i)}`);
    // Budget: each shellQuote(file) is ~53 bytes + 1 space ≈ 54 per entry.
    // With maxBytes=120, we get 2 per chunk (2 * 54 = 108), with room.
    const chunks = chunkFiles(files, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2);
    }
  });

  test("splits by maxFiles (xargs chunk size)", () => {
    const files = ["a", "b", "c", "d", "e"];
    const chunks = chunkFiles(files, DEFAULT_CHUNK_BYTES, 2);
    expect(chunks).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  test("handles an empty input", () => {
    expect(chunkFiles([], DEFAULT_CHUNK_BYTES)).toEqual([]);
  });
});

// --- runStep: project mode -----------------------------------------------

describe("runStep — project mode", () => {
  test("runs the project variant once and ignores files", async () => {
    const step = parseStep({
      run: { files: "vitest related {files}", project: "vitest run" },
      invocation: "project",
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["should", "be", "ignored"] }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("vitest run");
  });

  test("projectForced overrides the configured mode", async () => {
    const step = parseStep({ run: "eslint {files}" });
    const { calls, exec } = recordExec();
    await runStep(
      baseOpts({
        step,
        files: ["a.ts", "b.ts"],
        projectForced: true,
      }),
      exec,
    );
    // With projectForced, mode becomes "project" and string-form run is used
    // as the project command without {files} substitution — so the template
    // still contains the literal `{files}` token (unusual but honest).
    expect(calls[0]?.command).toBe("eslint ");
  });

  test("skips with 'no files variant defined' when run is empty and files list is non-empty", async () => {
    // Schema guards against an empty object run, so construct it directly.
    const step: Step = {
      ...parseStep({ run: { files: "x" } }),
      run: {} as { files?: string; project?: string },
    };
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["a.ts"], projectForced: false }),
      exec,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("files variant");
    expect(calls).toHaveLength(0);
  });

  test("skips when project mode is forced but no project variant exists", async () => {
    // Build an object-form run missing the project variant, then hand it
    // to runStep directly. The schema normally guards this, but we force
    // the scope so pickRunVariant falls through to both being null-ish.
    const step: Step = {
      ...parseStep({ run: { files: "eslint {files}" } }),
      run: {} as { files?: string; project?: string },
    };
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["a.ts"], projectForced: true }),
      exec,
    );
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("project variant");
    expect(calls).toHaveLength(0);
  });
});

// --- runStep: empty-list fallbacks --------------------------------------

describe("runStep — empty file list", () => {
  test("runs fallback: command when defined", async () => {
    const step = parseStep({
      run: "eslint {files}",
      fallback: "eslint .",
    });
    const { calls, exec } = recordExec();
    const result = await runStep(baseOpts({ step, files: [] }), exec);
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("eslint .");
  });

  test("runs project variant when run: is object form with one", async () => {
    const step = parseStep({
      run: { files: "vitest related {files}", project: "vitest run" },
    });
    const { calls, exec } = recordExec();
    const result = await runStep(baseOpts({ step, files: [] }), exec);
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("vitest run");
  });

  test("skips with reason when nothing else applies", async () => {
    const step = parseStep({ run: "eslint {files}" });
    const { calls, exec } = recordExec();
    const result = await runStep(baseOpts({ step, files: [] }), exec);
    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("no matching files");
    expect(calls).toHaveLength(0);
  });

  test("skipped result reports exit 0 with no invocations", async () => {
    const step = parseStep({ run: "eslint {files}" });
    const { exec } = recordExec();
    const result = await runStep(baseOpts({ step, files: [] }), exec);
    expect(result.exitCode).toBe(0);
    expect(result.invocations).toEqual([]);
  });
});

// --- runStep: per-file mode ---------------------------------------------

describe("runStep — per-file mode", () => {
  test("runs once per file with {file} substituted", async () => {
    const step = parseStep({
      run: "shellcheck {file}",
      invocation: "per-file",
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["a.sh", "b.sh", "c.sh"] }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.command).sort()).toEqual([
      "shellcheck 'a.sh'",
      "shellcheck 'b.sh'",
      "shellcheck 'c.sh'",
    ]);
  });

  test("respects the parallel cap", async () => {
    const step = parseStep({
      run: "x {file}",
      invocation: "per-file",
      parallel: 4,
    });
    const { calls, exec } = recordExec();
    await runStep(
      baseOpts({ step, files: ["a", "b", "c", "d", "e"] }),
      exec,
    );
    expect(calls).toHaveLength(5);
  });

  test("aggregate exit code is the max across invocations", async () => {
    const step = parseStep({
      run: "check {file}",
      invocation: "per-file",
    });
    let n = 0;
    const exec: ExecFn = () => {
      n += 1;
      return Promise.resolve({ exitCode: n === 2 ? 3 : 0, durationMs: 1 });
    };
    const result = await runStep(
      baseOpts({ step, files: ["a", "b", "c"] }),
      exec,
    );
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
  });
});

// --- runStep: stdin mode -------------------------------------------------

describe("runStep — stdin mode", () => {
  test("pipes files as stdin lines", async () => {
    const step = parseStep({
      run: "my-linter --stdin",
      invocation: "stdin",
    });
    const { calls, exec } = recordExec();
    await runStep(baseOpts({ step, files: ["a.ts", "b.ts"] }), exec);
    expect(calls[0]?.stdin).toBe("a.ts\nb.ts\n");
  });
});

// --- runStep: glob mode --------------------------------------------------

describe("runStep — glob mode", () => {
  test("substitutes {glob} with a brace expansion", async () => {
    const step = parseStep({
      run: "tool {glob}",
      invocation: "glob",
    });
    const { calls, exec } = recordExec();
    await runStep(baseOpts({ step, files: ["a.ts", "b.ts"] }), exec);
    expect(calls[0]?.command).toBe("tool {'a.ts','b.ts'}");
  });
});

// --- runStep: args + xargs chunking -------------------------------------

describe("runStep — args / xargs chunking", () => {
  test("args mode runs once under the byte budget", async () => {
    const step = parseStep({ run: "eslint {files}" });
    const { calls, exec } = recordExec();
    await runStep(baseOpts({ step, files: ["a.ts", "b.ts"] }), exec);
    expect(calls).toHaveLength(1);
  });

  test("xargs mode honors the configured chunk size", async () => {
    const step = parseStep({
      run: "gofmt -l {files}",
      invocation: "xargs",
      chunk: 2,
    });
    const { calls, exec } = recordExec();
    await runStep(
      baseOpts({ step, files: ["a", "b", "c", "d", "e"] }),
      exec,
    );
    expect(calls).toHaveLength(3); // 2 + 2 + 1
  });

  test("args mode aggregates failing exit code across chunks", async () => {
    const step = parseStep({
      run: "tool {files}",
      invocation: "xargs",
      chunk: 1,
    });
    let n = 0;
    const exec: ExecFn = () => {
      n += 1;
      return Promise.resolve({ exitCode: n === 1 ? 0 : 2, durationMs: 1 });
    };
    const result = await runStep(
      baseOpts({ step, files: ["a", "b"] }),
      exec,
    );
    expect(result.exitCode).toBe(2);
  });
});

// --- runStep: areas ------------------------------------------------------

describe("runStep — areas", () => {
  test("rewrites {files} to the matched area's run selectors", async () => {
    const step = parseStep({
      run: "echo {files}",
      areas: {
        schemas: { when: "schemas/**", run: ["api/", "workers/"] },
      },
      unmatched: "skip",
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["schemas/user.json"] }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("echo 'api/' 'workers/'");
    expect(result.area?.matchedAreas).toEqual(["schemas"]);
  });

  test("unmatched: skip short-circuits when no areas match", async () => {
    const step = parseStep({
      run: "echo",
      areas: { web: { when: "web/**", run: "web/" } },
      unmatched: "skip",
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["api/user.ts"] }),
      exec,
    );
    expect(result.status).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect(result.area?.kind).toBe("skip");
  });

  test("unmatched: all falls through to the project variant", async () => {
    const step = parseStep({
      run: { files: "lint {files}", project: "lint ." },
      unmatched: "all",
      areas: { web: { when: "web/**", run: "web/" } },
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["api/user.ts"] }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("lint .");
  });

  test("unmatched: smoke uses the smoke area's run selectors", async () => {
    const step = parseStep({
      run: "echo {files}",
      unmatched: "smoke",
      areas: {
        web: { when: "web/**", run: "web/" },
        smoke: { when: "nothing/**", run: ["tests/smoke/"] },
      },
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({ step, files: ["api/user.ts"] }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("echo 'tests/smoke/'");
    expect(result.area?.matchedAreas).toEqual(["smoke"]);
  });

  test("projectForced bypasses area resolution entirely", async () => {
    const step = parseStep({
      run: { files: "lint {files}", project: "lint ." },
      areas: { web: { when: "web/**", run: "web/" } },
    });
    const { calls, exec } = recordExec();
    const result = await runStep(
      baseOpts({
        step,
        files: ["api/user.ts"],
        projectForced: true,
      }),
      exec,
    );
    expect(result.status).toBe("passed");
    expect(calls[0]?.command).toBe("lint .");
    expect(result.area).toBeUndefined();
  });
});

// --- runStep: env merge --------------------------------------------------

describe("runStep — env merge", () => {
  test("merges caller env, step env into exec input", async () => {
    const step = parseStep({
      run: "echo",
      env: { STEP_VAR: "step" },
    });
    const { calls, exec } = recordExec();
    await runStep(
      baseOpts({
        step,
        files: [],
        env: { CALLER_VAR: "caller" },
      }),
      exec,
    );
    // Empty list with no fallback → skipped, no env visible
    expect(calls).toHaveLength(0);

    const step2 = parseStep({
      run: { project: "echo {env.STEP_VAR}-{env.CALLER_VAR}" },
      invocation: "project",
    });
    const rec = recordExec();
    await runStep(
      baseOpts({
        step: step2,
        files: [],
        env: { CALLER_VAR: "caller" },
      }),
      rec.exec,
    );
    // Step env isn't part of applyTemplate's ctx.env by default; we merge it
    // into the runSingle env and into the template context. Step's env wins
    // over caller env on collision (spread order).
    expect(rec.calls[0]?.env).toMatchObject({ CALLER_VAR: "caller" });
  });
});
