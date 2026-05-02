import path from "node:path";
import type { Detector, DetectorContext, DetectorFragment } from "./types.ts";

const BIOME_CONFIG_FILES = ["biome.json", "biome.jsonc"] as const;
const BIOME_PACKAGES = ["@biomejs/biome", "biome"] as const;

async function readPackageJson(
  ctx: DetectorContext,
): Promise<Record<string, unknown> | null> {
  const packageJsonPath = path.join(ctx.cwd, "package.json");
  if (!(await ctx.fs.exists(packageJsonPath))) return null;
  try {
    return JSON.parse(await ctx.fs.read(packageJsonPath)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function dependenciesFor(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof pkg.devDependencies === "object" && pkg.devDependencies
      ? (pkg.devDependencies as Record<string, unknown>)
      : {}),
    ...(typeof pkg.dependencies === "object" && pkg.dependencies
      ? (pkg.dependencies as Record<string, unknown>)
      : {}),
    ...(typeof pkg.optionalDependencies === "object" && pkg.optionalDependencies
      ? (pkg.optionalDependencies as Record<string, unknown>)
      : {}),
    ...(typeof pkg.peerDependencies === "object" && pkg.peerDependencies
      ? (pkg.peerDependencies as Record<string, unknown>)
      : {}),
  };
}

function hasBiomeDependency(pkg: Record<string, unknown> | null): boolean {
  if (!pkg) return false;
  const deps = dependenciesFor(pkg);
  return BIOME_PACKAGES.some((name) => name in deps);
}

async function hasBiomeConfig(ctx: DetectorContext): Promise<boolean> {
  for (const fileName of BIOME_CONFIG_FILES) {
    if (await ctx.fs.exists(path.join(ctx.cwd, fileName))) return true;
  }
  return false;
}

export async function hasBiome(ctx: DetectorContext): Promise<boolean> {
  return (
    (await hasBiomeConfig(ctx)) ||
    hasBiomeDependency(await readPackageJson(ctx))
  );
}

function biomeFragment(): DetectorFragment {
  return {
    steps: {
      lint: {
        run: {
          files: "biome check {files}",
          project: "biome check .",
        },
        files: "**/*.{js,jsx,ts,tsx,mjs,cjs,json,jsonc,css}",
        tags: ["fast", "lint"],
        description: "Run Biome checks on affected files (full project on CI)",
      },
    },
    pipelines: {
      ci: { steps: ["lint"] },
      "pre-commit": { steps: ["lint"], parallel: true },
      "agent-edit": { steps: ["lint"], parallel: true },
    },
    notes: [
      "Detected Biome — scaffolded `biome check` as the primary JS/TS/JSON/CSS lint/format check.",
    ],
  };
}

export const biomeDetector: Detector = {
  name: "biome",
  displayName: "Biome",
  detect: hasBiome,
  async template(ctx) {
    if (!(await hasBiome(ctx))) return {};
    return biomeFragment();
  },
};
