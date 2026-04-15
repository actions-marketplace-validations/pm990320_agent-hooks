import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FIXTURES_ROOT = path.join(import.meta.dir, "..", "..", "fixtures");

export interface Fixture {
  /** Absolute path to the temp copy of the fixture. */
  readonly cwd: string;
  /** Tear down the temp copy. Always call from afterEach/afterAll. */
  readonly cleanup: () => Promise<void>;
}

export interface CopyFixtureOptions {
  /** Run `git init` + commit the starting state. Default: true. */
  readonly initGit?: boolean;
  /** Ensure shell scripts under `scripts/` are executable. Default: true. */
  readonly chmodScripts?: boolean;
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function chmodExecutablesUnder(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await chmodExecutablesUnder(p);
      } else if (entry.isFile() && entry.name.endsWith(".sh")) {
        await fs.chmod(p, 0o755);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

function runGit(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", [...args], {
    cwd,
    stdio: "ignore",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

/**
 * Copy a fixture into a fresh tempdir so tests can mutate it without
 * touching the committed version. Optionally initializes a git repo and
 * commits the starting state so scope-relative commands ("changed",
 * "staged") have something to diff against.
 */
export async function copyFixture(
  name: string,
  options: CopyFixtureOptions = {},
): Promise<Fixture> {
  const src = path.join(FIXTURES_ROOT, name);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `agent-hooks-${name}-`));
  await copyDir(src, tmp);

  if (options.chmodScripts !== false) {
    await chmodExecutablesUnder(path.join(tmp, "scripts"));
  }

  if (options.initGit !== false) {
    runGit(["init", "-q", "-b", "main"], tmp);
    runGit(["config", "user.email", "test@example.com"], tmp);
    runGit(["config", "user.name", "agent-hooks tests"], tmp);
    // commit.gpgsign can be set in the ambient user config; disable for tests
    runGit(["config", "commit.gpgsign", "false"], tmp);
    runGit(["add", "."], tmp);
    runGit(["commit", "-q", "-m", "fixture init"], tmp);
  }

  return {
    cwd: tmp,
    async cleanup() {
      await fs.rm(tmp, { recursive: true, force: true });
    },
  };
}

/** Stage a file by path so `--staged` scope has something to resolve. */
export async function stageFile(cwd: string, relPath: string): Promise<void> {
  const absPath = path.join(cwd, relPath);
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(absPath, "\n// modified for test\n");
  runGit(["add", relPath], cwd);
}

/** Read a file from inside a fixture — handy for assertions. */
export async function readFixtureFile(
  cwd: string,
  relPath: string,
): Promise<string> {
  return fs.readFile(path.join(cwd, relPath), "utf8");
}

/** Check whether a file exists inside a fixture. */
export async function fixtureFileExists(
  cwd: string,
  relPath: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, relPath));
    return true;
  } catch {
    return false;
  }
}
