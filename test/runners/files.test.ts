import { describe, expect, test } from "bun:test";
import {
  createGitRunner,
  defaultSpawner,
  filterByGlob,
  GitNotInstalledError,
  NotAGitRepositoryError,
  resolveFiles,
  UnresolvableBaseRefError,
  wrapSpawnError,
  type GitRunner,
  type Spawner,
} from "../../src/runners/files.ts";

function stubGit(partial: Partial<GitRunner> = {}): GitRunner {
  return {
    staged: () => Promise.resolve([]),
    changed: () => Promise.resolve([]),
    all: () => Promise.resolve([]),
    ...partial,
  };
}

describe("resolveFiles", () => {
  test("explicit scope uses the provided files verbatim", async () => {
    const git = stubGit();
    const result = await resolveFiles(git, {
      scope: "explicit",
      files: ["a.ts", "b.ts"],
    });
    expect(result).toEqual({ scope: "explicit", files: ["a.ts", "b.ts"] });
  });

  test("explicit scope defaults to an empty list when `files` is omitted", async () => {
    const result = await resolveFiles(stubGit(), { scope: "explicit" });
    expect(result.files).toEqual([]);
  });

  test("explicit scope rejects paths outside the repo root", async () => {
    const git = stubGit();
    await expect(
      resolveFiles(git, {
        scope: "explicit",
        files: ["../../../etc/passwd"],
        repoRoot: "/repo",
      }),
    ).rejects.toThrow(/outside the repo root/);
  });

  test("explicit scope rejects absolute paths outside the repo root", async () => {
    const git = stubGit();
    await expect(
      resolveFiles(git, {
        scope: "explicit",
        files: ["/etc/passwd"],
        repoRoot: "/repo",
      }),
    ).rejects.toThrow(/outside the repo root/);
  });

  test("explicit scope accepts paths inside the repo root", async () => {
    const git = stubGit();
    const result = await resolveFiles(git, {
      scope: "explicit",
      files: ["src/a.ts", "src/nested/b.ts"],
      repoRoot: "/repo",
    });
    expect(result.files).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });

  test("explicit scope with allowOutsideRepo bypasses the boundary check", async () => {
    const git = stubGit();
    const result = await resolveFiles(git, {
      scope: "explicit",
      files: ["/etc/passwd"],
      repoRoot: "/repo",
      allowOutsideRepo: true,
    });
    expect(result.files).toEqual(["/etc/passwd"]);
  });

  test("explicit scope with no repoRoot is a noop boundary check", async () => {
    const git = stubGit();
    const result = await resolveFiles(git, {
      scope: "explicit",
      files: ["/anywhere"],
    });
    expect(result.files).toEqual(["/anywhere"]);
  });

  test("staged scope shells out to git.staged()", async () => {
    const git = stubGit({
      staged: () => Promise.resolve(["src/a.ts", "src/b.ts"]),
    });
    const result = await resolveFiles(git, { scope: "staged" });
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("changed scope shells out to git.changed() with the base ref", async () => {
    let receivedRef: string | undefined;
    const git = stubGit({
      changed: (ref) => {
        receivedRef = ref;
        return Promise.resolve(["src/changed.ts"]);
      },
    });
    const result = await resolveFiles(git, {
      scope: "changed",
      baseRef: "origin/develop",
    });
    expect(receivedRef).toBe("origin/develop");
    expect(result.files).toEqual(["src/changed.ts"]);
  });

  test("all scope shells out to git.all()", async () => {
    const git = stubGit({
      all: () => Promise.resolve(["a.ts", "b.ts", "c.ts"]),
    });
    const result = await resolveFiles(git, { scope: "all" });
    expect(result.files).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("dedupes and drops empty strings", async () => {
    const git = stubGit({
      staged: () => Promise.resolve(["a.ts", "", "a.ts", "b.ts"]),
    });
    const result = await resolveFiles(git, { scope: "staged" });
    expect(result.files).toEqual(["a.ts", "b.ts"]);
  });
});

describe("filterByGlob", () => {
  test("returns the list unchanged when the glob is undefined", () => {
    const files = ["a.ts", "b.md"];
    expect(filterByGlob(files, undefined)).toEqual(files);
  });

  test("returns the list unchanged when the glob is the empty string", () => {
    const files = ["a.ts", "b.md"];
    expect(filterByGlob(files, "")).toEqual(files);
  });

  test("filters TypeScript files with a brace glob", () => {
    const files = ["src/a.ts", "src/b.tsx", "docs/c.md", "src/d.js"];
    expect(filterByGlob(files, "**/*.{ts,tsx}")).toEqual([
      "src/a.ts",
      "src/b.tsx",
    ]);
  });

  test("treats dot-prefixed paths as matchable", () => {
    const files = [".github/workflows/ci.yml", "src/a.ts"];
    expect(filterByGlob(files, "**/*.yml")).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  test("nocase: true matches across case differences", () => {
    const files = ["src/Foo.ts", "src/BAR.ts"];
    expect(filterByGlob(files, "src/foo.*", { nocase: true })).toEqual([
      "src/Foo.ts",
    ]);
    expect(filterByGlob(files, "**/*.TS", { nocase: true })).toEqual(files);
  });

  test("nocase: false enforces exact case (Linux semantics)", () => {
    const files = ["src/Foo.ts", "src/bar.ts"];
    expect(filterByGlob(files, "src/foo.*", { nocase: false })).toEqual([]);
    expect(filterByGlob(files, "src/bar.*", { nocase: false })).toEqual([
      "src/bar.ts",
    ]);
  });
});

describe("createGitRunner", () => {
  /**
   * Strip the `-c core.quotePath=false` global prefix and the `-z`
   * filename-mode flag before keying the response table, so test
   * fixtures stay readable. Calls are still recorded verbatim.
   */
  function fakeSpawner(
    responses: Record<
      string,
      { stdout: string; stderr?: string; exitCode?: number; signal?: string }
    >,
  ): { spawner: Spawner; calls: string[][] } {
    const calls: string[][] = [];
    const spawner: Spawner = (command, _cwd) => {
      calls.push([...command]);
      const meaningful = command
        .slice(1)
        .filter(
          (arg, i, arr) =>
            !(arg === "-c" && arr[i + 1] === "core.quotePath=false") &&
            arg !== "core.quotePath=false" &&
            arg !== "-z",
        );
      const key = meaningful.join(" ");
      const match = responses[key] ?? { stdout: "", exitCode: 0 };
      return Promise.resolve({
        stdout: match.stdout,
        stderr: match.stderr ?? "",
        exitCode: match.exitCode ?? 0,
        signal: match.signal ?? null,
      });
    };
    return { spawner, calls };
  }

  test("staged() passes the expected git args (with -z and quotePath=false)", async () => {
    const { spawner, calls } = fakeSpawner({
      "diff --cached --name-only --diff-filter=ACMRT": {
        // NUL-delimited because staged() now uses runZ.
        stdout: "src/a.ts\0src/b.ts\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.staged();
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
    expect(calls[0]).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=ACMRT",
      "-z",
    ]);
  });

  test("changed() resolves merge-base then diffs against it", async () => {
    const { spawner, calls } = fakeSpawner({
      "rev-parse --verify --quiet origin/main^{commit}": {
        stdout: "deadbeef\n",
      },
      "merge-base deadbeef HEAD": { stdout: "abc123\n" },
      "diff --name-only --diff-filter=ACMRT abc123...HEAD": {
        stdout: "src/a.ts\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.changed();
    expect(result).toEqual(["src/a.ts"]);
    expect(calls).toHaveLength(3);
  });

  test("changed() falls back to the resolved ref when merge-base returns nothing", async () => {
    const { spawner } = fakeSpawner({
      "rev-parse --verify --quiet origin/main^{commit}": {
        stdout: "deadbeef\n",
      },
      "merge-base deadbeef HEAD": { stdout: "" },
      "diff --name-only --diff-filter=ACMRT deadbeef...HEAD": {
        stdout: "src/x.ts\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.changed();
    expect(result).toEqual(["src/x.ts"]);
  });

  test("changed() falls back to local main when origin/main is missing", async () => {
    const { spawner, calls } = fakeSpawner({
      "rev-parse --verify --quiet origin/main^{commit}": {
        stdout: "",
        exitCode: 1,
      },
      "rev-parse --verify --quiet main^{commit}": { stdout: "abc123\n" },
      "merge-base abc123 HEAD": { stdout: "abc123\n" },
      "diff --name-only --diff-filter=ACMRT abc123...HEAD": {
        stdout: "src/y.ts\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.changed();
    expect(result).toEqual(["src/y.ts"]);
    // Verifies the fallback chain: tried origin/main, then main.
    // Index 1+2 because the global -c core.quotePath=false prefix
    // is at positions 1 and 2.
    expect(calls[0]?.slice(0, 7)).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "rev-parse",
      "--verify",
      "--quiet",
      "origin/main^{commit}",
    ]);
    expect(calls[1]?.slice(0, 7)).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "rev-parse",
      "--verify",
      "--quiet",
      "main^{commit}",
    ]);
  });

  test("changed() throws UnresolvableBaseRefError when no candidate exists", async () => {
    const { spawner } = fakeSpawner({
      "rev-parse --verify --quiet origin/main^{commit}": {
        stdout: "",
        exitCode: 1,
      },
      "rev-parse --verify --quiet main^{commit}": { stdout: "", exitCode: 1 },
      "rev-parse --verify --quiet master^{commit}": {
        stdout: "",
        exitCode: 1,
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.changed()).rejects.toThrow(/origin\/main/);
    await expect(git.changed()).rejects.toThrow(/--base/);
  });

  test("changed() with explicit baseRef does not fall through the default chain", async () => {
    const { spawner, calls } = fakeSpawner({
      "rev-parse --verify --quiet feature/x^{commit}": {
        stdout: "",
        exitCode: 1,
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.changed("feature/x")).rejects.toThrow(/feature\/x/);
    // Only one rev-parse attempt — no implicit main/master fallback when
    // the user named a specific branch.
    expect(
      calls.filter((c) => c.includes("rev-parse")).length,
    ).toBe(1);
  });

  test("all() uses git ls-files with --cached --others --exclude-standard -z", async () => {
    const { spawner, calls } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "a.ts\0b.ts\0c.md\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.all();
    expect(result).toEqual(["a.ts", "b.ts", "c.md"]);
    expect(calls[0]).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
  });

  test("all() preserves filenames with embedded newlines via -z splitting", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "wei\nrd.txt\0normal.txt\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.all();
    expect(result).toEqual(["wei\nrd.txt", "normal.txt"]);
  });

  test("all() returns non-ASCII paths verbatim (quotePath=false)", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "café.txt\0résumé.md\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.all();
    expect(result).toEqual(["café.txt", "résumé.md"]);
  });

  test("throws when git exits non-zero", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "",
        exitCode: 128,
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.all()).rejects.toThrow("exited with code 128");
  });

  test("throws NotAGitRepositoryError when git stderr says so", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "",
        stderr:
          "fatal: not a git repository (or any of the parent directories): .git",
        exitCode: 128,
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.all()).rejects.toThrow(NotAGitRepositoryError);
    await expect(git.all()).rejects.toThrow("/repo");
  });

  test("surfaces signal name when git is killed by a signal", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "",
        // Bun coerces signal exits to 128+N but exposes signalCode for
        // the human-readable name. We surface that distinctly.
        exitCode: 137,
        signal: "SIGKILL",
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.all()).rejects.toThrow("killed by SIGKILL");
  });

  test("wraps spawn ENOENT for git as GitNotInstalledError", async () => {
    const enoentSpawner: Spawner = () => {
      const err = new Error(
        'Executable not found in $PATH: "git"',
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      return Promise.reject(err);
    };
    // Wrap manually because the production wrapping lives in
    // defaultSpawner; this pins the contract that GitRunner consumers
    // see GitNotInstalledError when the spawner can't find git.
    const wrapping: Spawner = async (command, cwd) => {
      try {
        return await enoentSpawner(command, cwd);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && command[0] === "git") {
          throw new GitNotInstalledError();
        }
        throw err;
      }
    };
    const git = createGitRunner("/repo", wrapping);
    await expect(git.all()).rejects.toThrow(GitNotInstalledError);
    await expect(git.all()).rejects.toThrow(/git is not installed/);
  });

  test("UnresolvableBaseRefError carries the original baseRef", () => {
    const err = new UnresolvableBaseRefError("origin/main", [
      "origin/main",
      "main",
      "master",
    ]);
    expect(err.message).toContain("origin/main");
    expect(err.message).toContain("main, master");
    expect(err.name).toBe("UnresolvableBaseRefError");
  });

  test("attaches the stderr tail when git exits non-zero with a message", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "",
        stderr: "fatal: bad object HEAD",
        exitCode: 128,
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.all()).rejects.toThrow(/bad object HEAD/);
  });

  test("throws NotAGitRepositoryError on 'not a git repository' stderr", async () => {
    const { spawner } = fakeSpawner({
      "ls-files --cached --others --exclude-standard": {
        stdout: "",
        stderr: "fatal: not a git repository (or any parent up to mount point /)",
        exitCode: 128,
      },
    });
    const git = createGitRunner("/not-a-repo", spawner);
    await expect(git.all()).rejects.toThrow(/not a git repository/);
  });

  test("tryRevParse surfaces NotAGitRepositoryError via rev-parse", async () => {
    const { spawner } = fakeSpawner({
      "rev-parse --verify --quiet origin/main^{commit}": {
        stdout: "",
        exitCode: 128,
        stderr: "fatal: not a git repository",
      },
    });
    const git = createGitRunner("/not-a-repo", spawner);
    await expect(git.changed()).rejects.toThrow(/not a git repository/);
  });

  test("modifiedUnder parses porcelain=v1 -z output", async () => {
    const { spawner, calls } = fakeSpawner({
      "status --porcelain=v1 -- .beads": {
        // " M .beads/db.json\0?? .beads/issues/abc.md\0"
        // (X=space, Y=M, path, NUL).
        stdout: " M .beads/db.json\0?? .beads/issues/abc.md\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.modifiedUnder?.(".beads");
    expect(result).toEqual([".beads/db.json", ".beads/issues/abc.md"]);
    expect(calls[0]).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--",
      ".beads",
    ]);
  });

  test("modifiedUnder consumes the second path on a rename entry", async () => {
    const { spawner } = fakeSpawner({
      "status --porcelain=v1 -- .beads": {
        // R<space><space>new.md\0old.md\0 M .beads/db.json\0
        stdout:
          "R  .beads/new.md\0.beads/old.md\0 M .beads/db.json\0",
      },
    });
    const git = createGitRunner("/repo", spawner);
    const result = await git.modifiedUnder?.(".beads");
    // Only the destination path is emitted for the rename; the next
    // real entry (.beads/db.json) still parses correctly.
    expect(result).toEqual([".beads/new.md", ".beads/db.json"]);
  });

  test("modifiedUnder returns [] on non-zero exit", async () => {
    const { spawner } = fakeSpawner({
      "status --porcelain=v1 -- .beads": {
        stdout: "",
        exitCode: 128,
      },
    });
    const git = createGitRunner("/repo", spawner);
    expect(await git.modifiedUnder?.(".beads")).toEqual([]);
  });

  test("stage calls git add -- <paths>", async () => {
    const { spawner, calls } = fakeSpawner({
      "add -- .beads/db.json .beads/issues/abc.md": { stdout: "" },
    });
    const git = createGitRunner("/repo", spawner);
    await git.stage?.([".beads/db.json", ".beads/issues/abc.md"]);
    expect(calls[0]).toEqual([
      "git",
      "-c",
      "core.quotePath=false",
      "add",
      "--",
      ".beads/db.json",
      ".beads/issues/abc.md",
    ]);
  });

  test("stage is a noop when given an empty path list", async () => {
    const { spawner, calls } = fakeSpawner({});
    const git = createGitRunner("/repo", spawner);
    await git.stage?.([]);
    expect(calls).toEqual([]);
  });

  test("stage throws when git add fails", async () => {
    const { spawner } = fakeSpawner({
      "add -- .beads/db.json": {
        stdout: "",
        exitCode: 128,
        stderr: "fatal: pathspec error",
      },
    });
    const git = createGitRunner("/repo", spawner);
    await expect(git.stage?.([".beads/db.json"])).rejects.toThrow(
      /pathspec error/,
    );
  });
});

describe("defaultSpawner", () => {
  test("runs a real command and captures stdout + exit code", async () => {
    const result = await defaultSpawner(["git", "--version"], process.cwd());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git");
  });

  test("captures stderr too", async () => {
    // `git --invalid-flag` writes to stderr and exits non-zero.
    const result = await defaultSpawner(
      ["git", "--invalid-flag-xyz"],
      process.cwd(),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("re-throws spawn ENOENT for non-git binaries verbatim (covers the catch branch)", async () => {
    // Bun.spawn throws synchronously for a missing binary. Used here
    // to drive defaultSpawner's catch branch through wrapSpawnError —
    // for non-git, wrapSpawnError is a passthrough.
    let caught: Error | null = null;
    try {
      await defaultSpawner(
        ["xyz-definitely-not-a-real-binary-1234"],
        process.cwd(),
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(caught).not.toBeInstanceOf(GitNotInstalledError);
  });

});

describe("wrapSpawnError", () => {
  function enoent(): NodeJS.ErrnoException {
    const err = new Error('Executable not found in $PATH: "git"') as NodeJS.ErrnoException;
    err.code = "ENOENT";
    return err;
  }

  test("converts ENOENT for git into GitNotInstalledError", () => {
    const result = wrapSpawnError(enoent(), ["git", "--version"]);
    expect(result).toBeInstanceOf(GitNotInstalledError);
  });

  test("passes ENOENT for non-git binaries through unchanged", () => {
    const original = enoent();
    const result = wrapSpawnError(original, ["other-binary"]);
    expect(result).toBe(original);
  });

  test("passes non-ENOENT errors through unchanged", () => {
    const original = new Error("permission denied") as NodeJS.ErrnoException;
    original.code = "EACCES";
    const result = wrapSpawnError(original, ["git", "status"]);
    expect(result).toBe(original);
  });
});

import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";

describe("createGitRunner — real-git invariants", () => {
  // These run against actual `git` in throwaway tempdirs. They exist to
  // pin behavior in repo states agent-hooks must survive: fresh repos
  // with no remote, untracked-only repos, dirs that aren't repos at all.
  function git(args: readonly string[], cwd: string): void {
    const r = spawnSync("git", [...args], { cwd, stdio: "ignore" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
    }
  }

  function makeTmp(): Promise<string> {
    return nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "ah-files-test-"));
  }

  test("changed() does not crash in a repo with no remote (no origin/main)", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@t"], dir);
      git(["config", "user.name", "t"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      await nodeFs.writeFile(nodePath.join(dir, "a.txt"), "a\n");
      git(["add", "a.txt"], dir);
      git(["commit", "-q", "-m", "init"], dir);

      const runner = createGitRunner(dir);
      const result = await runner.changed();
      // The contract: don't crash. A meaningful list or an empty
      // list are both acceptable; what we cannot ship is the raw
      // "exit 128" wrapping that pre-fix users got.
      expect(Array.isArray(result)).toBe(true);
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("all() includes untracked, .gitignored excluded", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@t"], dir);
      git(["config", "user.name", "t"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      await nodeFs.writeFile(nodePath.join(dir, "tracked.txt"), "x\n");
      git(["add", "tracked.txt"], dir);
      git(["commit", "-q", "-m", "init"], dir);
      // After commit: add an untracked file and an ignored file.
      await nodeFs.writeFile(nodePath.join(dir, ".gitignore"), "ignored.log\n");
      await nodeFs.writeFile(nodePath.join(dir, "untracked.txt"), "y\n");
      await nodeFs.writeFile(nodePath.join(dir, "ignored.log"), "z\n");

      const runner = createGitRunner(dir);
      const result = await runner.all();
      expect(result).toContain("tracked.txt");
      expect(result).toContain("untracked.txt");
      expect(result).toContain(".gitignore");
      expect(result).not.toContain("ignored.log");
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("all() returns a friendly error when cwd is not a git repo", async () => {
    const dir = await makeTmp();
    try {
      const runner = createGitRunner(dir);
      let caught: Error | null = null;
      try {
        await runner.all();
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      // The error should mention "not a git repository" (or be wrapped
      // so the user understands the cause), not just "exited with code 128".
      expect(caught!.message.toLowerCase()).toContain("not a git repository");
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("all() works in a fresh repo with no commits", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      await nodeFs.writeFile(nodePath.join(dir, "untracked.txt"), "x\n");

      const runner = createGitRunner(dir);
      const result = await runner.all();
      expect(result).toContain("untracked.txt");
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("changed() error message mentions the unresolved base when a bogus baseRef is passed", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@t"], dir);
      git(["config", "user.name", "t"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      await nodeFs.writeFile(nodePath.join(dir, "a.txt"), "a\n");
      git(["add", "a.txt"], dir);
      git(["commit", "-q", "-m", "init"], dir);

      const runner = createGitRunner(dir);
      let caught: Error | null = null;
      try {
        await runner.changed("definitely/not/a/ref");
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).toContain("definitely/not/a/ref");
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("all() returns non-ASCII filenames raw, not as C-quoted escapes", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@t"], dir);
      git(["config", "user.name", "t"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      // Default core.quotePath=true would emit "caf\303\251.txt" — the
      // -c override the runner threads on every invocation prevents it.
      await nodeFs.writeFile(nodePath.join(dir, "café.txt"), "x\n");
      await nodeFs.writeFile(nodePath.join(dir, "résumé.md"), "y\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", "init"], dir);

      const runner = createGitRunner(dir);
      const result = await runner.all();
      expect(result).toContain("café.txt");
      expect(result).toContain("résumé.md");
      // No C-style escapes anywhere.
      for (const path of result) {
        expect(path.startsWith('"')).toBe(false);
        expect(path).not.toContain("\\303");
      }
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });

  test("all() preserves filenames with embedded newlines via -z", async () => {
    const dir = await makeTmp();
    try {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@t"], dir);
      git(["config", "user.name", "t"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      // Literal newline in a filename — legal on POSIX, lethal for
      // newline-mode parsers. Survives because the runner uses -z.
      const weirdName = "wei\nrd.txt";
      await nodeFs.writeFile(nodePath.join(dir, weirdName), "x\n");
      await nodeFs.writeFile(nodePath.join(dir, "normal.txt"), "y\n");

      const runner = createGitRunner(dir);
      const result = await runner.all();
      // The weird name should appear as a single entry, not split in two.
      expect(result).toContain(weirdName);
      expect(result).toContain("normal.txt");
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });
});
