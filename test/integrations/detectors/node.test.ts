import { describe, expect, test } from "bun:test";
import {
  bunDetector,
  npmDetector,
  pnpmDetector,
  yarnDetector,
} from "../../../src/integrations/detectors/node.ts";
import type { DetectorFs } from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (p) => Promise.resolve(p in files),
    read: (p) => {
      if (!(p in files)) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(files[p]!);
    },
  };
}

describe("bunDetector", () => {
  test("fires when bun.lockb exists", async () => {
    const fs = memFs({ "/repo/bun.lockb": "" });
    expect(await bunDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires when bun.lock (newer text format) exists", async () => {
    const fs = memFs({ "/repo/bun.lock": "" });
    expect(await bunDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires when packageManager: bun@... is set", async () => {
    const fs = memFs({
      "/repo/package.json": JSON.stringify({ packageManager: "bun@1.2.15" }),
    });
    expect(await bunDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("does not fire when only npm signals are present", async () => {
    const fs = memFs({ "/repo/package-lock.json": "" });
    expect(await bunDetector.detect({ cwd: "/repo", fs })).toBe(false);
  });

  test("template emits lint/typecheck/test/build steps + reinstall hook", async () => {
    const fs = memFs({ "/repo/bun.lockb": "" });
    const fragment = await bunDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("bun run lint");
    expect(fragment.steps?.["typecheck"]?.run).toContain("bun x tsc --noEmit");
    expect(fragment.steps?.["test"]?.run).toContain("bun test {files}");
    expect(fragment.steps?.["build"]?.run).toContain("bun run build");
    expect(fragment.steps?.["install-deps"]?.run).toBe("bun install");
    expect(fragment.gitHooks?.["post-merge"]?.pipeline).toBe("reinstall");
  });

  test("template returns empty when not detected", async () => {
    const fs = memFs({});
    const fragment = await bunDetector.template({ cwd: "/repo", fs });
    expect(fragment).toEqual({});
  });
});

describe("pnpmDetector", () => {
  test("fires on pnpm-lock.yaml", async () => {
    const fs = memFs({ "/repo/pnpm-lock.yaml": "" });
    expect(await pnpmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template uses pnpm runner", async () => {
    const fs = memFs({ "/repo/pnpm-lock.yaml": "" });
    const fragment = await pnpmDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toBe("pnpm run lint");
    expect(fragment.steps?.["test"]?.run).toBe("pnpm run test");
    expect(fragment.steps?.["install-deps"]?.run).toBe("pnpm install");
  });

  test("template returns empty when no pnpm signals", async () => {
    const fs = memFs({});
    expect(await pnpmDetector.template({ cwd: "/repo", fs })).toEqual({});
  });
});

describe("yarnDetector", () => {
  test("fires on yarn.lock", async () => {
    const fs = memFs({ "/repo/yarn.lock": "" });
    expect(await yarnDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template uses yarn runner (no `run` prefix)", async () => {
    const fs = memFs({ "/repo/yarn.lock": "" });
    const fragment = await yarnDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toBe("yarn lint");
    expect(fragment.steps?.["install-deps"]?.run).toBe("yarn install");
  });
});

describe("npmDetector", () => {
  test("fires on package-lock.json", async () => {
    const fs = memFs({ "/repo/package-lock.json": "" });
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires on bare package.json with no lockfile", async () => {
    const fs = memFs({ "/repo/package.json": "{}" });
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template uses npm + npx", async () => {
    const fs = memFs({ "/repo/package-lock.json": "" });
    const fragment = await npmDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["typecheck"]?.run).toBe("npx tsc --noEmit");
    expect(fragment.steps?.["install-deps"]?.run).toBe("npm install");
  });

  test("packageManager: pnpm@... → pnpmDetector wins, npm doesn't fire", async () => {
    const fs = memFs({
      "/repo/package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }),
    });
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(false);
    expect(await pnpmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("packageManager: yarn@... routes to yarnDetector", async () => {
    const fs = memFs({
      "/repo/package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }),
    });
    expect(await yarnDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("packageManager: npm@... routes to npmDetector", async () => {
    const fs = memFs({
      "/repo/package.json": JSON.stringify({ packageManager: "npm@10.0.0" }),
    });
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("invalid package.json JSON falls through to lockfile detection", async () => {
    const fs = memFs({
      "/repo/package.json": "this is not json",
      "/repo/package-lock.json": "",
    });
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("returns false when no package.json or lockfile", async () => {
    const fs = memFs({});
    expect(await npmDetector.detect({ cwd: "/repo", fs })).toBe(false);
  });
});
