import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import nodeFs from "node:fs/promises";
import nodeOs from "node:os";
import nodePath from "node:path";
import {
  defaultEnvResolver,
  parseJsonObject,
  parseShellExports,
  prependPath,
  resolveEnvironment,
  type EnvCommandResult,
  type EnvFs,
  type EnvResolver,
} from "../../src/runners/env-resolution.ts";

// --- Helpers -------------------------------------------------------------

interface FakeOptions {
  files?: Set<string>;
  commands?: Set<string>;
  exec?: Map<string, EnvCommandResult>;
}

function memFs(files: Set<string>): EnvFs {
  return { exists: (p) => Promise.resolve(files.has(p)) };
}

function fakeResolver(opts: FakeOptions = {}): EnvResolver {
  const files = opts.files ?? new Set<string>();
  const commands = opts.commands ?? new Set<string>();
  const execMap = opts.exec ?? new Map<string, EnvCommandResult>();
  return {
    fs: memFs(files),
    whichCommand: (name) =>
      Promise.resolve(commands.has(name) ? `/usr/bin/${name}` : null),
    run: (cmd) => {
      const key = cmd.join(" ");
      return Promise.resolve(
        execMap.get(key) ?? { stdout: "", stderr: "", exitCode: 1 },
      );
    },
  };
}

// --- prependPath ---------------------------------------------------------

describe("prependPath", () => {
  test("prepends to a non-empty path", () => {
    expect(prependPath("/usr/bin:/bin", "/opt/bin")).toBe(
      "/opt/bin:/usr/bin:/bin",
    );
  });

  test("returns the dir alone for an empty path", () => {
    expect(prependPath("", "/opt/bin")).toBe("/opt/bin");
  });

  test("is idempotent when dir is already at the front", () => {
    const path = "/opt/bin:/usr/bin";
    expect(prependPath(path, "/opt/bin")).toBe(path);
  });

  test("removes a duplicate copy elsewhere in the list", () => {
    expect(prependPath("/usr/bin:/opt/bin:/bin", "/opt/bin")).toBe(
      "/opt/bin:/usr/bin:/bin",
    );
  });
});

// --- parseJsonObject -----------------------------------------------------

describe("parseJsonObject", () => {
  test("parses a flat string→string object", () => {
    expect(parseJsonObject('{"FOO":"bar","BAZ":"qux"}')).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("coerces numbers and booleans to strings", () => {
    expect(parseJsonObject('{"PORT":3000,"DEBUG":true}')).toEqual({
      PORT: "3000",
      DEBUG: "true",
    });
  });

  test("returns null for arrays", () => {
    expect(parseJsonObject('["a","b"]')).toBeNull();
  });

  test("returns null for null", () => {
    expect(parseJsonObject("null")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseJsonObject("{not json")).toBeNull();
  });

  test("ignores nested object values rather than flattening", () => {
    expect(parseJsonObject('{"FOO":"bar","NESTED":{"x":1}}')).toEqual({
      FOO: "bar",
    });
  });
});

// --- parseShellExports ---------------------------------------------------

describe("parseShellExports", () => {
  test("parses bare assignments", () => {
    expect(parseShellExports("FOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  test("strips a leading export keyword", () => {
    expect(parseShellExports("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("strips matching surrounding quotes", () => {
    expect(parseShellExports('FOO="bar baz"\nQUX=\'a b\'')).toEqual({
      FOO: "bar baz",
      QUX: "a b",
    });
  });

  test("ignores comments and blank lines", () => {
    expect(parseShellExports("# comment\n\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  test("ignores invalid identifiers", () => {
    expect(parseShellExports("9FOO=bar\n FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("handles trailing semicolons", () => {
    expect(parseShellExports("export FOO=bar;")).toEqual({ FOO: "bar" });
  });

  test("ignores lines without an = sign", () => {
    expect(parseShellExports("just a line\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  test("ignores assignments where = is the first character", () => {
    expect(parseShellExports("=value\nFOO=bar")).toEqual({ FOO: "bar" });
  });
});

// --- resolveEnvironment --------------------------------------------------

describe("resolveEnvironment", () => {
  test("returns the base env when no layers fire", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { FOO: "bar" } },
      fakeResolver(),
    );
    expect(result.env).toEqual({ FOO: "bar" });
    expect(result.sources.length).toBe(1);
    expect(result.sources[0]?.kind).toBe("process");
  });

  test("layers direnv when .envrc + direnv binary are present", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/bin" } },
      fakeResolver({
        files: new Set(["/repo/.envrc"]),
        commands: new Set(["direnv"]),
        exec: new Map([
          [
            "direnv export json",
            {
              stdout: '{"FROM_DIRENV":"yes","PATH":"/direnv/bin:/bin"}',
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      }),
    );
    expect(result.env.FROM_DIRENV).toBe("yes");
    expect(result.env.PATH).toBe("/direnv/bin:/bin");
    expect(result.sources.some((s) => s.kind === "direnv")).toBe(true);
  });

  test("emits a note when .envrc exists but direnv is not on PATH", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({ files: new Set(["/repo/.envrc"]) }),
    );
    expect(result.sources.some((s) => s.kind === "direnv")).toBe(false);
    expect(result.notes.join(" ")).toContain("direnv");
  });

  test("emits a note when direnv export json fails", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.envrc"]),
        commands: new Set(["direnv"]),
        exec: new Map([
          [
            "direnv export json",
            { stdout: "", stderr: "boom", exitCode: 2 },
          ],
        ]),
      }),
    );
    expect(result.sources.some((s) => s.kind === "direnv")).toBe(false);
    expect(result.notes[0]).toContain("direnv export json failed");
  });

  test("treats empty direnv output as a silent no-op", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.envrc"]),
        commands: new Set(["direnv"]),
        exec: new Map([
          ["direnv export json", { stdout: "  \n", stderr: "", exitCode: 0 }],
        ]),
      }),
    );
    expect(result.sources.some((s) => s.kind === "direnv")).toBe(false);
    expect(result.notes).toEqual([]);
  });

  test("emits a note when direnv returns invalid JSON", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.envrc"]),
        commands: new Set(["direnv"]),
        exec: new Map([
          ["direnv export json", { stdout: "not json", stderr: "", exitCode: 0 }],
        ]),
      }),
    );
    expect(result.sources.some((s) => s.kind === "direnv")).toBe(false);
    expect(result.notes[0]).toContain("invalid JSON");
  });

  test("layers mise when .mise.toml + mise binary are present", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/bin" } },
      fakeResolver({
        files: new Set(["/repo/.mise.toml"]),
        commands: new Set(["mise"]),
        exec: new Map([
          [
            "mise env --json",
            { stdout: '{"FROM_MISE":"yes"}', stderr: "", exitCode: 0 },
          ],
        ]),
      }),
    );
    expect(result.env.FROM_MISE).toBe("yes");
    expect(result.sources.some((s) => s.kind === "mise")).toBe(true);
  });

  test("layers mise when .tool-versions exists and mise is preferred", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.tool-versions"]),
        commands: new Set(["mise", "asdf"]),
        exec: new Map([
          [
            "mise env --json",
            { stdout: '{"NODE_VERSION":"22"}', stderr: "", exitCode: 0 },
          ],
        ]),
      }),
    );
    expect(result.env.NODE_VERSION).toBe("22");
    expect(result.sources.some((s) => s.kind === "mise")).toBe(true);
    expect(result.sources.some((s) => s.kind === "asdf")).toBe(false);
  });

  test("emits a note when .mise.toml exists but mise is not on PATH", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({ files: new Set(["/repo/.mise.toml"]) }),
    );
    expect(result.notes.join(" ")).toContain(".mise.toml");
  });

  test("emits no note when only .tool-versions exists and neither tool is installed", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({ files: new Set(["/repo/.tool-versions"]) }),
    );
    // mise didn't fire (no note), but asdf will note that neither tool is on PATH.
    expect(result.notes.join(" ")).toContain("neither");
  });

  test("emits a note when mise env --json fails", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.mise.toml"]),
        commands: new Set(["mise"]),
        exec: new Map([
          [
            "mise env --json",
            { stdout: "", stderr: "broken", exitCode: 1 },
          ],
        ]),
      }),
    );
    expect(result.notes[0]).toContain("mise env --json failed");
  });

  test("emits a note when mise returns invalid JSON", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.mise.toml"]),
        commands: new Set(["mise"]),
        exec: new Map([
          ["mise env --json", { stdout: "junk", stderr: "", exitCode: 0 }],
        ]),
      }),
    );
    expect(result.notes[0]).toContain("invalid JSON");
  });

  test("falls back to asdf when mise isn't installed but .tool-versions exists", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.tool-versions"]),
        commands: new Set(["asdf"]),
        exec: new Map([
          [
            "asdf shellenv sh",
            {
              stdout: 'export FROM_ASDF="yes"',
              stderr: "",
              exitCode: 0,
            },
          ],
        ]),
      }),
    );
    expect(result.env.FROM_ASDF).toBe("yes");
    expect(result.sources.some((s) => s.kind === "asdf")).toBe(true);
  });

  test("emits a note when asdf shellenv fails", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.tool-versions"]),
        commands: new Set(["asdf"]),
        exec: new Map([
          [
            "asdf shellenv sh",
            { stdout: "", stderr: "old asdf", exitCode: 1 },
          ],
        ]),
      }),
    );
    expect(result.notes[0]).toContain("asdf shellenv failed");
  });

  test("does not record an asdf source when shellenv outputs nothing parseable", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({
        files: new Set(["/repo/.tool-versions"]),
        commands: new Set(["asdf"]),
        exec: new Map([
          ["asdf shellenv sh", { stdout: "# nothing", stderr: "", exitCode: 0 }],
        ]),
      }),
    );
    expect(result.sources.some((s) => s.kind === "asdf")).toBe(false);
  });

  test("layers a Python venv when .venv/bin/python is present", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/usr/bin" } },
      fakeResolver({
        files: new Set(["/repo/.venv/bin/python"]),
      }),
    );
    expect(result.env.VIRTUAL_ENV).toBe("/repo/.venv");
    expect(result.env.PATH?.startsWith("/repo/.venv/bin")).toBe(true);
    expect(result.sources.some((s) => s.kind === "venv")).toBe(true);
  });

  test("falls back to venv/ then env/ for the venv directory", async () => {
    const venv = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/usr/bin" } },
      fakeResolver({ files: new Set(["/repo/venv/bin/python"]) }),
    );
    expect(venv.env.VIRTUAL_ENV).toBe("/repo/venv");

    const env = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/usr/bin" } },
      fakeResolver({ files: new Set(["/repo/env/bin/python"]) }),
    );
    expect(env.env.VIRTUAL_ENV).toBe("/repo/env");
  });

  test("adds node_modules/.bin to PATH when present", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: { PATH: "/usr/bin" } },
      fakeResolver({
        files: new Set(["/repo/node_modules/.bin"]),
      }),
    );
    expect(result.env.PATH?.startsWith("/repo/node_modules/.bin")).toBe(true);
    expect(result.sources.some((s) => s.kind === "node-bin")).toBe(true);
  });

  test("config env layers last and wins over auto layers", async () => {
    const result = await resolveEnvironment(
      {
        cwd: "/repo",
        baseEnv: { FOO: "from-process" },
        configEnv: { FOO: "from-config", EXTRA: "yes" },
      },
      fakeResolver(),
    );
    expect(result.env.FOO).toBe("from-config");
    expect(result.env.EXTRA).toBe("yes");
    expect(result.sources.some((s) => s.kind === "config")).toBe(true);
  });

  test("an empty config env block is not recorded as a source", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {}, configEnv: {} },
      fakeResolver(),
    );
    expect(result.sources.some((s) => s.kind === "config")).toBe(false);
  });

  test("uses an empty PATH gracefully when none is set", async () => {
    const result = await resolveEnvironment(
      { cwd: "/repo", baseEnv: {} },
      fakeResolver({ files: new Set(["/repo/node_modules/.bin"]) }),
    );
    expect(result.env.PATH).toBe("/repo/node_modules/.bin");
  });
});

// --- defaultEnvResolver --------------------------------------------------

describe("defaultEnvResolver", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "agent-hooks-env-"));
  });

  afterEach(async () => {
    await nodeFs.rm(tmp, { recursive: true, force: true });
  });

  test("fs.exists detects real files and missing ones", async () => {
    const file = nodePath.join(tmp, "marker");
    await nodeFs.writeFile(file, "x", "utf8");
    expect(await defaultEnvResolver.fs.exists(file)).toBe(true);
    expect(
      await defaultEnvResolver.fs.exists(nodePath.join(tmp, "missing")),
    ).toBe(false);
  });

  test("whichCommand finds real binaries on PATH", async () => {
    const env = { PATH: process.env.PATH ?? "" };
    const gitPath = await defaultEnvResolver.whichCommand("git", env);
    expect(gitPath).not.toBeNull();
    const nope = await defaultEnvResolver.whichCommand(
      "agent-hooks-not-a-real-bin",
      env,
    );
    expect(nope).toBeNull();
  });

  test("whichCommand handles an empty PATH", async () => {
    expect(await defaultEnvResolver.whichCommand("git", { PATH: "" })).toBeNull();
  });

  test("run executes a real command and returns its output", async () => {
    const result = await defaultEnvResolver.run(
      ["sh", "-c", "echo hello"],
      tmp,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("run reports a non-zero exit code", async () => {
    const result = await defaultEnvResolver.run(["sh", "-c", "exit 7"], tmp);
    expect(result.exitCode).toBe(7);
  });

  test("run swallows spawn failures into exit 127", async () => {
    const result = await defaultEnvResolver.run(
      ["agent-hooks-not-a-real-bin"],
      tmp,
    );
    expect(result.exitCode).toBe(127);
  });
});
