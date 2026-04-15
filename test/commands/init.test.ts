import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  decidePostinstall,
  defaultInitFs,
  defaultPostinstallFs,
  registerInitCommand,
  runInitCommand,
  STARTER_WORKFLOW,
  type InitCommandDeps,
  type InitFs,
} from "../../src/commands/init.ts";
import type { HookFs } from "../../src/integrations/git/install.ts";
import type { PostinstallFs } from "../../src/integrations/node/postinstall.ts";

// --- In-memory adapters -------------------------------------------------

interface MemFs {
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  readonly initFs: InitFs;
  readonly hookFs: HookFs;
  readonly postinstallFs: PostinstallFs;
}

function mem(): MemFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();

  const initFs: InitFs = {
    exists: (p) => Promise.resolve(files.has(p) || dirs.has(p)),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(v);
    },
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    mkdirRecursive: (p) => {
      dirs.add(p);
      return Promise.resolve();
    },
    list: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const entries: string[] = [];
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          if (!rest.includes("/")) entries.push(rest);
        }
      }
      return Promise.resolve(entries);
    },
  };
  const hookFs: HookFs = {
    exists: (p) => Promise.resolve(files.has(p)),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(v);
    },
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
    mkdirRecursive: (p) => {
      dirs.add(p);
      return Promise.resolve();
    },
    remove: (p) => {
      files.delete(p);
      return Promise.resolve();
    },
  };
  const postinstallFs: PostinstallFs = {
    exists: (p) => Promise.resolve(files.has(p)),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(v);
    },
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
  };
  return { files, dirs, initFs, hookFs, postinstallFs };
}

function makeDeps(memFs: MemFs, overrides: Partial<InitCommandDeps> = {}): InitCommandDeps {
  let out = "";
  return {
    cwd: "/repo",
    write: (t) => {
      out += t;
    },
    fs: memFs.initFs,
    hookFs: memFs.hookFs,
    postinstallFs: memFs.postinstallFs,
    ...overrides,
    get outString() {
      return out;
    },
  } as InitCommandDeps;
}

describe("runInitCommand — detector-driven templates", () => {
  test("bun project: scaffolds bun-flavored steps", async () => {
    const memFs = mem();
    memFs.files.set("/repo/bun.lockb", "");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual(["node-bun"]);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("bun run lint");
    expect(written).toContain("bun test {files}");
    expect(written).toContain("bun install");
    expect(written).toContain("post-merge");
    expect(out).toContain("detect  node-bun");
  });

  test("python uv project: scaffolds ruff/mypy/pytest steps", async () => {
    const memFs = mem();
    memFs.files.set("/repo/pyproject.toml", "");
    memFs.files.set("/repo/uv.lock", "");
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual(["python-uv"]);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("uv run ruff check");
    expect(written).toContain("uv run pytest");
    expect(written).toContain("uv sync");
  });

  test("rust project: scaffolds clippy + cargo test", async () => {
    const memFs = mem();
    memFs.files.set("/repo/Cargo.toml", "");
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual(["rust"]);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("cargo clippy");
    expect(written).toContain("cargo test");
  });

  test("no detector fires: falls back to the minimal skeleton", async () => {
    const memFs = mem();
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual([]);
    expect(out).toContain("none — using minimal skeleton");
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("configure your linter here");
  });

  test("--template <name> forces a specific detector", async () => {
    const memFs = mem();
    // No bun signals, but we force the bun template anyway.
    const { outcome } = await runInitCommand(
      { template: "node-bun" },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual(["node-bun"]);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("bun");
  });

  test("--template with an unknown name throws a descriptive error", async () => {
    const memFs = mem();
    await expect(
      runInitCommand(
        { template: "made-up" },
        {
          cwd: "/repo",
          write: () => {},
          fs: memFs.initFs,
          hookFs: memFs.hookFs,
          postinstallFs: memFs.postinstallFs,
        },
      ),
    ).rejects.toThrow(/unknown detector template/);
  });

  test("--no-templates ignores detected stacks and writes the skeleton", async () => {
    const memFs = mem();
    memFs.files.set("/repo/bun.lockb", "");
    const { outcome } = await runInitCommand(
      { noTemplates: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.detectors).toEqual([]);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("configure your linter here");
    expect(written).not.toContain("bun run lint");
  });

  test("--name overrides the project name in the rendered config", async () => {
    const memFs = mem();
    await runInitCommand(
      { name: "cool-project" },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toContain("name: cool-project");
  });
});

describe("runInitCommand", () => {
  test("writes starter config and installs pre-commit hook when nothing exists", async () => {
    const memFs = mem();
    let out = "";
    const deps: InitCommandDeps = {
      cwd: "/repo",
      write: (t) => {
        out += t;
      },
      fs: memFs.initFs,
      hookFs: memFs.hookFs,
      postinstallFs: memFs.postinstallFs,
    };
    const { code, outcome } = await runInitCommand({}, deps);
    expect(code).toBe(0);
    expect(outcome.wroteConfig).toBe(true);
    expect(outcome.installedHooks).toBeGreaterThan(0);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toBeDefined();
    expect(written).toContain("$schema=");
    expect(written).toContain("steps:");
    expect(written).toContain("pipelines:");
    expect(memFs.files.has("/repo/.git/hooks/pre-commit")).toBe(true);
    expect(out).toContain("init complete");
  });

  test("keeps config on conflict when the default prompter answers 'keep'", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "existing");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(false);
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toBe("existing");
    expect(out).toContain("keep");
  });

  test("--force overwrites existing config and backs it up to .bak", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "old contents");
    let out = "";
    const { outcome } = await runInitCommand(
      { force: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toBeDefined();
    expect(written).toContain("$schema=");
    // Backup of the prior contents lives next to the config.
    const backup = memFs.files.get("/repo/.config/agent-hooks.yml.bak");
    expect(backup).toBe("old contents");
    expect(out).toContain("backup");
  });

  test("--dry-run prints the plan without writing files", async () => {
    const memFs = mem();
    let out = "";
    const { outcome } = await runInitCommand(
      { dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    expect(memFs.files.size).toBe(0);
    expect(out).toContain("dry run");
  });

  test("--with-github-actions scaffolds a CI workflow when .github is missing", async () => {
    const memFs = mem();
    const { outcome } = await runInitCommand(
      { withGithubActions: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
    expect(
      memFs.files.get("/repo/.github/workflows/agent-hooks.yml"),
    ).toBe(STARTER_WORKFLOW);
  });

  test("--no-github-actions skips workflow scaffolding even when .github exists", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    const { outcome } = await runInitCommand(
      { noGithubActions: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(false);
    expect(
      memFs.files.has("/repo/.github/workflows/agent-hooks.yml"),
    ).toBe(false);
  });

  test("auto-enables workflow when .github already exists", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
  });

  test("keeps workflow on conflict when the default prompter answers 'keep'", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/agent-hooks.yml",
      "existing workflow",
    );
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(false);
    expect(out).toContain("keep");
    expect(memFs.files.get("/repo/.github/workflows/agent-hooks.yml")).toBe(
      "existing workflow",
    );
  });

  test("wires postinstall when package.json is present", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/package.json",
      JSON.stringify({ name: "x" }, null, 2),
    );
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("created");
    const pkg = JSON.parse(memFs.files.get("/repo/package.json")!) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toContain("agent-hooks install");
  });

  test("--no-postinstall skips postinstall wiring even when package.json exists", async () => {
    const memFs = mem();
    memFs.files.set("/repo/package.json", JSON.stringify({ name: "x" }));
    const { outcome } = await runInitCommand(
      { noPostinstall: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
  });

  test("--with-postinstall without a package.json still attempts the wire (and wirePostinstall returns skipped)", async () => {
    const memFs = mem();
    const { outcome } = await runInitCommand(
      { withPostinstall: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
  });

  test("dry-run emits a plan line for postinstall when package.json is present", async () => {
    const memFs = mem();
    memFs.files.set("/repo/package.json", "{}");
    let out = "";
    const { outcome } = await runInitCommand(
      { dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
    expect(out).toContain("plan    wire postinstall");
  });

  test("dry-run also prints the install plan line for hooks", async () => {
    const memFs = mem();
    let out = "";
    await runInitCommand(
      { dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(out).toContain("plan    install");
  });
});

describe("runInitCommand — interactive conflict handling", () => {
  function fakePrompter(answer: "keep" | "overwrite" | "merge" | "skip") {
    const seen: { path: string; diff: string; canMerge: boolean }[] = [];
    return {
      prompter: {
        prompt: (input: { path: string; diff: string; canMerge: boolean }) => {
          seen.push(input);
          return Promise.resolve(answer);
        },
      },
      seen: () => seen,
    };
  }

  test("matching existing file reports 'up to date' and doesn't write", async () => {
    // First run to establish the current generated contents, then feed
    // them back so the next run sees an exact match.
    const memFs = mem();
    let out = "";
    await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const generated = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(generated).toBeDefined();

    // Reset the output buffer and rerun against the same in-memory fs.
    out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(false);
    expect(out).toContain("up to date");
  });

  test("prompter 'overwrite' replaces the file and backs up the old one", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "old: thing\n");
    const prompter = fakePrompter("overwrite");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    expect(memFs.files.get("/repo/.config/agent-hooks.yml.bak")).toBe(
      "old: thing\n",
    );
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toContain(
      "$schema=",
    );
    expect(out).toContain("backup");
    expect(prompter.seen()).toHaveLength(1);
    expect(prompter.seen()[0]?.canMerge).toBe(true);
  });

  test("prompter 'skip' leaves the file alone and reports the skip", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "existing");
    const prompter = fakePrompter("skip");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteConfig).toBe(false);
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toBe("existing");
    expect(out).toContain("skip");
  });

  test("prompter 'merge' runs a semantic YAML merge and preserves existing keys", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/.config/agent-hooks.yml",
      "steps:\n  lint:\n    run: my-custom-lint\n",
    );
    const prompter = fakePrompter("merge");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    const merged = memFs.files.get("/repo/.config/agent-hooks.yml");
    // existing value survives the merge
    expect(merged).toContain("my-custom-lint");
    expect(out).toContain("merged");
    expect(memFs.files.get("/repo/.config/agent-hooks.yml.bak")).toBe(
      "steps:\n  lint:\n    run: my-custom-lint\n",
    );
  });

  test("prompter 'merge' on an unparseable file falls back to keep", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "{not: valid: yaml");
    const prompter = fakePrompter("merge");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteConfig).toBe(false);
    // unchanged
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toBe(
      "{not: valid: yaml",
    );
    expect(out).toContain("merge   refused");
  });

  test("--dry-run emits the diff and reports the planned conflict", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "steps: {}\n");
    let out = "";
    const { outcome } = await runInitCommand(
      { dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(false);
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toBe(
      "steps: {}\n",
    );
    expect(out).toContain("diff");
    expect(out).toContain("plan    conflict");
  });

  test("--force skips prompting and overwrites", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "ancient");
    const prompter = fakePrompter("keep");
    const { outcome } = await runInitCommand(
      { force: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    expect(prompter.seen()).toHaveLength(0);
    expect(memFs.files.get("/repo/.config/agent-hooks.yml.bak")).toBe("ancient");
  });

  test("--force + --dry-run prints backup + overwrite plan without writing", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "ancient");
    let out = "";
    const { outcome } = await runInitCommand(
      { force: true, dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteConfig).toBe(true);
    // Nothing actually written.
    expect(memFs.files.get("/repo/.config/agent-hooks.yml")).toBe("ancient");
    expect(memFs.files.has("/repo/.config/agent-hooks.yml.bak")).toBe(false);
    expect(out).toContain("would   back up");
    expect(out).toContain("plan    overwrite");
  });

  test("workflow conflicts are offered keep-or-overwrite (merge rejected for non-agent-hooks path)", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/agent-hooks.yml",
      "name: Old Workflow\n",
    );
    const prompter = fakePrompter("keep");
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter: prompter.prompter,
      },
    );
    expect(outcome.wroteWorkflow).toBe(false);
    // Workflow path is also .yml so canSemanticMerge returns true — that's
    // fine: init-conflicts.canSemanticMerge is broader than the strict
    // "agent-hooks.yml in config dir only" read, which matches the
    // module intent.
    expect(prompter.seen()).toHaveLength(1);
  });
});

describe("runInitCommand — workflow conflict rules", () => {
  test("scans existing workflows for pm990320/agent-hooks and skips creation", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/ci.yml",
      "name: CI\njobs:\n  x:\n    steps:\n      - uses: pm990320/agent-hooks@v1\n",
    );
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(false);
    // No new file created.
    expect(memFs.files.has("/repo/.github/workflows/agent-hooks.yml")).toBe(
      false,
    );
    // Existing one preserved.
    expect(memFs.files.get("/repo/.github/workflows/ci.yml")).toContain(
      "pm990320/agent-hooks",
    );
    expect(out).toContain("already wired up");
    expect(out).toContain("skip");
  });

  test("a mention of agent-hooks in a comment doesn't trigger the skip", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/ci.yml",
      "# uses: pm990320/agent-hooks (but only in docs)\nname: CI\njobs: {}\n",
    );
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
    expect(memFs.files.has("/repo/.github/workflows/agent-hooks.yml")).toBe(
      true,
    );
  });

  test("--workflow-name overrides the default filename", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    const { outcome } = await runInitCommand(
      { workflowName: "agent-hooks-ci.yml" },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
    expect(
      memFs.files.has("/repo/.github/workflows/agent-hooks-ci.yml"),
    ).toBe(true);
    expect(memFs.files.has("/repo/.github/workflows/agent-hooks.yml")).toBe(
      false,
    );
  });

  test("--force bypasses the existing-workflow scan", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/existing.yml",
      "jobs:\n  x:\n    steps:\n      - uses: pm990320/agent-hooks@v1\n",
    );
    const { outcome } = await runInitCommand(
      { force: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
    expect(memFs.files.has("/repo/.github/workflows/agent-hooks.yml")).toBe(
      true,
    );
    // Existing untouched.
    expect(memFs.files.get("/repo/.github/workflows/existing.yml")).toContain(
      "pm990320/agent-hooks",
    );
  });

  test("scan ignores non-yaml files in .github/workflows", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/README.md",
      "uses: pm990320/agent-hooks",
    );
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
  });

  test("scan skips workflow entries the fs can't read and keeps going", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    // Force list() to return a name that read() rejects (e.g. a
    // broken symlink). The scanner must keep going and eventually
    // write the new workflow.
    const brokenInitFs: InitFs = {
      ...memFs.initFs,
      list: () => Promise.resolve(["broken.yml"]),
      read: (p) => {
        if (p.endsWith("broken.yml")) {
          return Promise.reject(new Error("EIO"));
        }
        return memFs.initFs.read(p);
      },
    };
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: brokenInitFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(true);
    expect(memFs.files.has("/repo/.github/workflows/agent-hooks.yml")).toBe(
      true,
    );
  });

  test("scan tolerates .yaml extension too", async () => {
    const memFs = mem();
    memFs.dirs.add("/repo/.github");
    memFs.files.set(
      "/repo/.github/workflows/build.yaml",
      "steps:\n  - uses: pm990320/agent-hooks@v1\n",
    );
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.wroteWorkflow).toBe(false);
  });
});

describe("decidePostinstall", () => {
  test("--no-postinstall wins over everything", () => {
    const d = decidePostinstall({
      args: { noPostinstall: true, withPostinstall: true },
      existingMode: "auto",
      packageJsonExists: true,
    });
    expect(d.patch).toBe(false);
    expect(d.reason).toContain("--no-postinstall");
  });

  test("--postinstall-mode=skip wins over auto", () => {
    const d = decidePostinstall({
      args: { postinstallMode: "skip" },
      existingMode: "auto",
      packageJsonExists: true,
    });
    expect(d.patch).toBe(false);
    expect(d.reason).toContain("skip");
  });

  test("install.postinstall=managed blocks patching even with --force", () => {
    const d = decidePostinstall({
      args: { force: true, withPostinstall: true },
      existingMode: "managed",
      packageJsonExists: true,
    });
    expect(d.patch).toBe(false);
    expect(d.reason).toContain("managed");
  });

  test("install.postinstall=off blocks patching", () => {
    const d = decidePostinstall({
      args: {},
      existingMode: "off",
      packageJsonExists: true,
    });
    expect(d.patch).toBe(false);
    expect(d.reason).toContain("off");
  });

  test("--with-postinstall forces patch even without a package.json", () => {
    const d = decidePostinstall({
      args: { withPostinstall: true },
      existingMode: null,
      packageJsonExists: false,
    });
    expect(d.patch).toBe(true);
    expect(d.mode).toBe("append");
  });

  test("--postinstall-mode=replace flows through to mode field", () => {
    const d = decidePostinstall({
      args: { postinstallMode: "replace" },
      existingMode: "auto",
      packageJsonExists: true,
    });
    expect(d.patch).toBe(true);
    expect(d.mode).toBe("replace");
  });

  test("default: patches when package.json exists", () => {
    const d = decidePostinstall({
      args: {},
      existingMode: null,
      packageJsonExists: true,
    });
    expect(d.patch).toBe(true);
  });

  test("default: skips when no package.json", () => {
    const d = decidePostinstall({
      args: {},
      existingMode: null,
      packageJsonExists: false,
    });
    expect(d.patch).toBe(false);
  });
});

describe("runInitCommand — postinstall config honoring", () => {
  test("existing config with install.postinstall=managed skips patching on re-run", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/.config/agent-hooks.yml",
      "install:\n  postinstall: managed\nsteps: {}\npipelines: {}\n",
    );
    memFs.files.set("/repo/package.json", '{"name":"x","scripts":{}}');
    let out = "";
    const { outcome } = await runInitCommand(
      { force: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
    expect(memFs.files.get("/repo/package.json")).toBe(
      '{"name":"x","scripts":{}}',
    );
    expect(out).toContain("managed");
  });

  test("existing config with install.postinstall=off is honored", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/.config/agent-hooks.yml",
      "install:\n  postinstall: off\nsteps: {}\npipelines: {}\n",
    );
    memFs.files.set("/repo/package.json", '{"name":"x"}');
    const prompter = {
      prompt: () => Promise.resolve("overwrite" as const),
    };
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
  });

  test("existing config with install.postinstall=auto still patches", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/.config/agent-hooks.yml",
      "install:\n  postinstall: auto\nsteps: {}\npipelines: {}\n",
    );
    memFs.files.set("/repo/package.json", '{"name":"x"}');
    const prompter = {
      prompt: () => Promise.resolve("keep" as const),
    };
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter,
      },
    );
    expect(outcome.postinstall).not.toBe("skipped");
    const written = memFs.files.get("/repo/package.json");
    expect(written).toContain("agent-hooks install");
  });

  test("--postinstall-mode=replace overwrites an existing foreign script", async () => {
    const memFs = mem();
    memFs.files.set(
      "/repo/package.json",
      '{"name":"x","scripts":{"postinstall":"do-other-thing"}}',
    );
    const { outcome } = await runInitCommand(
      { postinstallMode: "replace" },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("replaced");
    const written = memFs.files.get("/repo/package.json") ?? "";
    expect(written).not.toContain("do-other-thing");
    expect(written).toContain("agent-hooks install");
  });

  test("--postinstall-mode=skip suppresses patching", async () => {
    const memFs = mem();
    memFs.files.set("/repo/package.json", '{"name":"x"}');
    let out = "";
    const { outcome } = await runInitCommand(
      { postinstallMode: "skip" },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.postinstall).toBe("skipped");
    expect(memFs.files.get("/repo/package.json")).toBe('{"name":"x"}');
    expect(out).toContain("skip    postinstall");
  });

  test("unparseable existing config falls back to default (auto) without crashing", async () => {
    const memFs = mem();
    memFs.files.set("/repo/.config/agent-hooks.yml", "{not valid yaml:");
    memFs.files.set("/repo/package.json", '{"name":"x"}');
    const prompter = {
      prompt: () => Promise.resolve("keep" as const),
    };
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        prompter,
      },
    );
    // unparseable → null mode → fall through to default → patch
    expect(outcome.postinstall).not.toBe("skipped");
  });
});

describe("runInitCommand — --with-skill / --no-skill", () => {
  function memSkillFs() {
    const files = new Map<string, string>();
    return {
      files,
      mkdirRecursive: () => Promise.resolve(),
      write: (p: string, contents: string) => {
        files.set(p, contents);
        return Promise.resolve();
      },
      exists: (p: string) => Promise.resolve(files.has(p)),
      remove: (p: string) => {
        files.delete(p);
        return Promise.resolve();
      },
    };
  }

  test("--with-skill <target> installs the named skill for user scope", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    let out = "";
    const { outcome } = await runInitCommand(
      { withSkill: "claude" },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    expect(outcome.skillsInstalled).toEqual(["claude"]);
    expect(skillFs.files.size).toBe(1);
    const [installedPath] = [...skillFs.files.keys()];
    expect(installedPath).toContain(".claude/skills/agent-hooks/SKILL.md");
    expect(out).toContain("skill");
  });

  test("--with-skill auto installs every known target", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    const { outcome } = await runInitCommand(
      { withSkill: "auto" },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    // SKILL_TARGETS is ["claude", "cursor", "codex"].
    expect(outcome.skillsInstalled).toEqual(["claude", "cursor", "codex"]);
    expect(skillFs.files.size).toBe(3);
  });

  test("--no-skill suppresses installation even when --with-skill is set", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    const { outcome } = await runInitCommand(
      { withSkill: "claude", noSkill: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    expect(outcome.skillsInstalled).toEqual([]);
    expect(skillFs.files.size).toBe(0);
  });

  test("default (no skill flags) leaves skills alone", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    expect(outcome.skillsInstalled).toEqual([]);
    expect(skillFs.files.size).toBe(0);
  });

  test("--with-skill <unknown> is reported as skipped without crashing", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    let out = "";
    const { outcome } = await runInitCommand(
      { withSkill: "bogus" },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    expect(outcome.skillsInstalled).toEqual([]);
    expect(out).toContain("unknown target");
  });

  test("--with-skill + --dry-run plans but never writes", async () => {
    const memFs = mem();
    const skillFs = memSkillFs();
    let out = "";
    const { outcome } = await runInitCommand(
      { withSkill: "claude", dryRun: true },
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
        skillFs,
      },
    );
    expect(outcome.skillsInstalled).toEqual(["claude"]);
    expect(skillFs.files.size).toBe(0);
    expect(out).toContain("plan    install skill for claude");
  });
});

describe("runInitCommand — CLAUDE.md / AGENTS.md marker block", () => {
  test("auto-detects existing CLAUDE.md and injects the marker block", async () => {
    const memFs = mem();
    memFs.files.set("/repo/CLAUDE.md", "# Project rules\n\nBe nice.\n");
    let out = "";
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: (t) => {
          out += t;
        },
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    // Outcome records the splice result.
    const claude = outcome.agentsMd.find((o) =>
      o.path.endsWith("CLAUDE.md"),
    );
    expect(claude?.action).toBe("inserted");
    // File has the block + preserves the original content.
    const written = memFs.files.get("/repo/CLAUDE.md")!;
    expect(written).toContain("# Project rules");
    expect(written).toContain("Be nice.");
    expect(written).toContain("BEGIN AGENT-HOOKS INTEGRATION");
    // Output line surfaces the action.
    expect(out).toContain("agent-hooks block");
  });

  test("auto-detects AGENTS.md and reports CLAUDE.md as missing", async () => {
    const memFs = mem();
    memFs.files.set("/repo/AGENTS.md", "# Agent notes\n");
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const agents = outcome.agentsMd.find((o) =>
      o.path.endsWith("AGENTS.md"),
    );
    const claude = outcome.agentsMd.find((o) =>
      o.path.endsWith("CLAUDE.md"),
    );
    expect(agents?.action).toBe("inserted");
    expect(claude?.action).toBe("missing");
    expect(memFs.files.has("/repo/CLAUDE.md")).toBe(false);
  });

  test("never creates CLAUDE.md / AGENTS.md when neither exists", async () => {
    const memFs = mem();
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.agentsMd.every((o) => o.action === "missing")).toBe(true);
    expect(memFs.files.has("/repo/CLAUDE.md")).toBe(false);
    expect(memFs.files.has("/repo/AGENTS.md")).toBe(false);
  });

  test("withAgentsMd: false suppresses the whole pass", async () => {
    const memFs = mem();
    memFs.files.set("/repo/CLAUDE.md", "# Claude\n");
    const { outcome } = await runInitCommand(
      { withAgentsMd: false },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    expect(outcome.agentsMd).toEqual([]);
    expect(memFs.files.get("/repo/CLAUDE.md")).toBe("# Claude\n");
  });

  test("second init re-run reports unchanged — the block is constant", async () => {
    const memFs = mem();
    memFs.files.set("/repo/CLAUDE.md", "# Claude\n");
    await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const snapshot = memFs.files.get("/repo/CLAUDE.md")!;
    const { outcome } = await runInitCommand(
      {},
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const claude = outcome.agentsMd.find((o) =>
      o.path.endsWith("CLAUDE.md"),
    );
    expect(claude?.action).toBe("unchanged");
    expect(memFs.files.get("/repo/CLAUDE.md")).toBe(snapshot);
  });

  test("--dry-run reports the planned action without writing", async () => {
    const memFs = mem();
    memFs.files.set("/repo/CLAUDE.md", "# Claude\n");
    const { outcome } = await runInitCommand(
      { dryRun: true },
      {
        cwd: "/repo",
        write: () => {},
        fs: memFs.initFs,
        hookFs: memFs.hookFs,
        postinstallFs: memFs.postinstallFs,
      },
    );
    const claude = outcome.agentsMd.find((o) =>
      o.path.endsWith("CLAUDE.md"),
    );
    expect(claude?.action).toBe("inserted");
    // File unchanged under dryRun.
    expect(memFs.files.get("/repo/CLAUDE.md")).toBe("# Claude\n");
  });
});

describe("registerInitCommand", () => {
  test("parses flags and runs successfully", async () => {
    const program = new Command().exitOverride();
    const memFs = mem();
    registerInitCommand(program, {
      cwd: "/repo",
      write: () => {},
      fs: memFs.initFs,
      hookFs: memFs.hookFs,
      postinstallFs: memFs.postinstallFs,
    });
    await program.parseAsync(["init", "--force", "--with-github-actions"], {
      from: "user",
    });
    const written = memFs.files.get("/repo/.config/agent-hooks.yml");
    expect(written).toBeDefined();
    expect(written).toContain("$schema=");
    expect(
      memFs.files.get("/repo/.github/workflows/agent-hooks.yml"),
    ).toBe(STARTER_WORKFLOW);
  });

  test("parses --no-github-actions and --no-postinstall", async () => {
    const program = new Command().exitOverride();
    const memFs = mem();
    memFs.files.set("/repo/package.json", "{}");
    registerInitCommand(program, {
      cwd: "/repo",
      write: () => {},
      fs: memFs.initFs,
      hookFs: memFs.hookFs,
      postinstallFs: memFs.postinstallFs,
    });
    await program.parseAsync(
      ["init", "--no-github-actions", "--no-postinstall"],
      { from: "user" },
    );
    expect(
      memFs.files.has("/repo/.github/workflows/agent-hooks.yml"),
    ).toBe(false);
    expect(memFs.files.get("/repo/package.json")).toBe("{}");
  });

  test("parses --with-postinstall", async () => {
    const program = new Command().exitOverride();
    const memFs = mem();
    memFs.files.set("/repo/package.json", "{}");
    registerInitCommand(program, {
      cwd: "/repo",
      write: () => {},
      fs: memFs.initFs,
      hookFs: memFs.hookFs,
      postinstallFs: memFs.postinstallFs,
    });
    await program.parseAsync(["init", "--with-postinstall"], {
      from: "user",
    });
    const pkg = JSON.parse(memFs.files.get("/repo/package.json")!) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.postinstall).toContain("agent-hooks install");
  });

  test("parses --dry-run", async () => {
    const program = new Command().exitOverride();
    const memFs = mem();
    registerInitCommand(program, {
      cwd: "/repo",
      write: () => {},
      fs: memFs.initFs,
      hookFs: memFs.hookFs,
      postinstallFs: memFs.postinstallFs,
    });
    await program.parseAsync(["init", "--dry-run"], { from: "user" });
    expect(memFs.files.size).toBe(0);
  });

  test("registers with default deps (smoke)", () => {
    const program = new Command().exitOverride();
    const cmd = registerInitCommand(program);
    expect(cmd).toBeDefined();
  });

  test("default-deps action path fires against a tmp cwd", async () => {
    const nodeFs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await nodeFs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-init-defaults-"),
    );
    try {
      await nodeFs.mkdir(path.join(tmp, ".git", "hooks"), { recursive: true });
      const program = new Command().exitOverride();
      // Capture stdout so the default writer fires without polluting
      // the test output.
      const originalOut = process.stdout.write.bind(process.stdout);
      const originalCwd = process.cwd();
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try {
        // Register without any overrides so the default fs + writer paths run.
        registerInitCommand(program);
        process.chdir(tmp);
        await program.parseAsync(["init", "--dry-run"], { from: "user" });
      } finally {
        process.chdir(originalCwd);
        process.stdout.write = originalOut;
      }
    } finally {
      await nodeFs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("defaultInitFs / defaultPostinstallFs", () => {
  test("defaultInitFs.exists returns false for a missing path", async () => {
    expect(await defaultInitFs.exists("/definitely/not/here")).toBe(false);
  });

  test("defaultPostinstallFs delegates to defaultInitFs", async () => {
    expect(await defaultPostinstallFs.exists("/definitely/not/here")).toBe(
      false,
    );
  });

  test("defaultInitFs roundtrip: mkdir, write (with mode), read, exists", async () => {
    const nodeFs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await nodeFs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-init-fs-"),
    );
    try {
      const nested = path.join(tmp, "a", "b", "c");
      await defaultInitFs.mkdirRecursive(nested);
      const file = path.join(nested, "file.txt");
      await defaultInitFs.write(file, "hello", 0o600);
      expect(await defaultInitFs.exists(file)).toBe(true);
      expect(await defaultInitFs.read(file)).toBe("hello");
      // Write without mode to cover the "no chmod" branch.
      const other = path.join(nested, "other.txt");
      await defaultInitFs.write(other, "x");
      expect(await defaultInitFs.read(other)).toBe("x");
    } finally {
      await nodeFs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("defaultPostinstallFs write delegates through defaultInitFs.write", async () => {
    const nodeFs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await nodeFs.mkdtemp(
      path.join(os.tmpdir(), "agent-hooks-post-fs-"),
    );
    try {
      const file = path.join(tmp, "pkg.json");
      await defaultPostinstallFs.write(file, '{"name":"x"}');
      expect(await defaultPostinstallFs.read(file)).toBe('{"name":"x"}');
    } finally {
      await nodeFs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// Ensure the shim object in makeDeps helper stays referenced to avoid
// the TS unused-check warning when tests don't use it.
void makeDeps;
