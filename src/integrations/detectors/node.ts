import path from "node:path";
import type {
  DetectedStep,
  Detector,
  DetectorContext,
  DetectorFragment,
} from "./types.ts";

/**
 * Given a `package.json` path, return the Node-family package manager
 * the project is using. Prefers the explicit `packageManager` field
 * when present, otherwise falls back to lockfile detection.
 */
export type NodePackageManager = "bun" | "pnpm" | "yarn" | "npm";

async function readPackageJson(
  ctx: DetectorContext,
): Promise<Record<string, unknown> | null> {
  const p = path.join(ctx.cwd, "package.json");
  if (!(await ctx.fs.exists(p))) return null;
  try {
    return JSON.parse(await ctx.fs.read(p)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function detectManager(
  ctx: DetectorContext,
): Promise<NodePackageManager | null> {
  const pkg = await readPackageJson(ctx);
  if (pkg) {
    const explicit = pkg.packageManager;
    if (typeof explicit === "string") {
      if (explicit.startsWith("bun@")) return "bun";
      if (explicit.startsWith("pnpm@")) return "pnpm";
      if (explicit.startsWith("yarn@")) return "yarn";
      if (explicit.startsWith("npm@")) return "npm";
    }
  }
  if (await ctx.fs.exists(path.join(ctx.cwd, "bun.lockb"))) return "bun";
  if (await ctx.fs.exists(path.join(ctx.cwd, "bun.lock"))) return "bun";
  if (await ctx.fs.exists(path.join(ctx.cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await ctx.fs.exists(path.join(ctx.cwd, "yarn.lock"))) return "yarn";
  if (await ctx.fs.exists(path.join(ctx.cwd, "package-lock.json"))) return "npm";
  if (pkg) return "npm"; // fall back to npm if package.json exists but no lockfile
  return null;
}

function runnerFor(
  manager: NodePackageManager,
): { run: string; exec: string; install: string } {
  switch (manager) {
    case "bun":
      return { run: "bun run", exec: "bun x", install: "bun install" };
    case "pnpm":
      return { run: "pnpm run", exec: "pnpm dlx", install: "pnpm install" };
    case "yarn":
      return { run: "yarn", exec: "yarn", install: "yarn install" };
    case "npm":
      return { run: "npm run", exec: "npx", install: "npm install" };
  }
}

/**
 * Detect the test framework from package.json devDependencies/dependencies.
 * Returns the framework name for which we have an affected-tests recipe,
 * or null for a generic fallback.
 */
type TestFramework = "vitest" | "jest" | null;

function detectTestFramework(
  pkg: Record<string, unknown> | null,
): TestFramework {
  if (!pkg) return null;
  const deps = {
    ...(typeof pkg.devDependencies === "object" && pkg.devDependencies
      ? (pkg.devDependencies as Record<string, unknown>)
      : {}),
    ...(typeof pkg.dependencies === "object" && pkg.dependencies
      ? (pkg.dependencies as Record<string, unknown>)
      : {}),
  };
  if ("vitest" in deps) return "vitest";
  if ("jest" in deps || "@jest/globals" in deps) return "jest";
  return null;
}

/**
 * Build the test step based on the detected test framework. Frameworks
 * that support affected-only testing (vitest, jest) get the two-form
 * run: syntax so agent-edit runs only related tests while CI runs the
 * full suite. Others fall back to a simple project-scoped run.
 */
function testStepFor(
  manager: NodePackageManager,
  r: { run: string; exec: string },
  framework: TestFramework,
): DetectedStep {
  const bunExec = manager === "bun" ? "bunx" : r.exec;
  if (framework === "vitest") {
    return {
      run: {
        files: `${bunExec} vitest related {files}`,
        project: `${bunExec} vitest run`,
      },
      files: "**/*.{ts,tsx,js,jsx}",
      tags: ["fast"],
      description: "Run affected tests via vitest (full suite on CI)",
    };
  }
  if (framework === "jest") {
    return {
      run: {
        files: `${bunExec} jest --findRelatedTests {files}`,
        project: `${bunExec} jest`,
      },
      files: "**/*.{ts,tsx,js,jsx}",
      tags: ["fast"],
      description: "Run affected tests via jest (full suite on CI)",
    };
  }
  return {
    run:
      manager === "bun"
        ? "bun test {files}"
        : `${r.run} test`,
    files: "**/*.{ts,tsx,js,jsx}",
    tags: ["fast"],
    description: `Run tests via ${manager}`,
  };
}

function nodeFragment(
  manager: NodePackageManager,
  testFramework: TestFramework = null,
): DetectorFragment {
  const r = runnerFor(manager);
  return {
    steps: {
      lint: {
        run: {
          files: `${r.exec} eslint {files}`,
          project: `${r.exec} eslint .`,
        },
        files: "**/*.{ts,tsx,js,jsx,mjs,cjs}",
        tags: ["fast", "lint"],
        description: `Lint affected files on edit, full project on CI`,
      },
      typecheck: {
        run: `${r.exec} tsc --noEmit`,
        invocation: "project",
        tags: ["fast"],
        description: `TypeScript project check via ${manager}`,
      },
      test: testStepFor(manager, r, testFramework),
      build: {
        run: `${r.run} build`,
        invocation: "project",
        tags: ["slow", "build"],
        description: `Build the project via ${manager}`,
      },
      "install-deps": {
        run: r.install,
        invocation: "project",
        description: `Re-install dependencies via ${manager}`,
      },
    },
    pipelines: {
      ci: {
        steps: ["lint", "typecheck", "test", "build"],
      },
      "pre-commit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
        "exclude-tags": ["slow"],
      },
      "agent-edit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
        "exclude-tags": ["slow"],
      },
      reinstall: {
        steps: ["install-deps"],
      },
    },
    gitHooks: {
      "post-merge": { pipeline: "reinstall" },
      "post-checkout": { pipeline: "reinstall" },
      "post-rewrite": { pipeline: "reinstall" },
    },
    notes: [
      `Detected ${manager} — scaffolded lint/typecheck/test/build steps plus a post-merge reinstall hook.`,
    ],
  };
}

function makeNodeDetector(
  name: NodePackageManager,
  displayName: string,
): Detector {
  return {
    name: `node-${name}`,
    displayName,
    async detect(ctx) {
      return (await detectManager(ctx)) === name;
    },
    async template(ctx) {
      const manager = await detectManager(ctx);
      if (manager !== name) return {};
      const pkg = await readPackageJson(ctx);
      const testFramework = detectTestFramework(pkg);
      return nodeFragment(manager, testFramework);
    },
  };
}

export const bunDetector: Detector = makeNodeDetector("bun", "Bun + TypeScript");
export const pnpmDetector: Detector = makeNodeDetector("pnpm", "Node (pnpm)");
export const yarnDetector: Detector = makeNodeDetector("yarn", "Node (yarn)");
export const npmDetector: Detector = makeNodeDetector("npm", "Node (npm)");
