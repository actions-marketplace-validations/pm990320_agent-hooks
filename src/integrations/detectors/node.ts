import path from "node:path";
import type {
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

function nodeFragment(manager: NodePackageManager): DetectorFragment {
  const r = runnerFor(manager);
  return {
    steps: {
      lint: {
        run: `${r.run} lint`,
        tags: ["fast", "lint"],
        description: `Run the project's \`lint\` script via ${manager}`,
      },
      typecheck: {
        run: `${r.exec} tsc --noEmit`,
        invocation: "project",
        tags: ["fast"],
        description: `TypeScript project check via ${manager}`,
      },
      test: {
        run:
          manager === "bun"
            ? `bun test {files}`
            : `${r.run} test`,
        files: "**/*.{ts,tsx,js,jsx}",
        tags: ["fast"],
        description: `Run tests via ${manager}`,
      },
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
      return nodeFragment(manager);
    },
  };
}

export const bunDetector: Detector = makeNodeDetector("bun", "Bun + TypeScript");
export const pnpmDetector: Detector = makeNodeDetector("pnpm", "Node (pnpm)");
export const yarnDetector: Detector = makeNodeDetector("yarn", "Node (yarn)");
export const npmDetector: Detector = makeNodeDetector("npm", "Node (npm)");
