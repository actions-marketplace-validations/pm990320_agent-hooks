import path from "node:path";
import YAML from "yaml";
import JSON5 from "json5";
import type { ZodError } from "zod";
import { ConfigError, ConfigNotFoundError } from "./errors.ts";
import { deepMerge } from "./merge.ts";
import { ConfigSchema, type Config } from "./schema.ts";

// Search priority — PLAN §3.1.
export const CONFIG_CANDIDATES: readonly string[] = [
  ".config/agent-hooks.yml",
  ".config/agent-hooks.yaml",
  ".config/agent-hooks.json",
  ".config/agent-hooks.json5",
  "agent-hooks.yml",
  "agent-hooks.yaml",
  "agent-hooks.json",
  "agent-hooks.json5",
];

// Local-overrides that are merged on top when present.
export const LOCAL_OVERRIDES: readonly string[] = [
  ".config/agent-hooks.local.yml",
  ".config/agent-hooks.local.yaml",
  ".config/agent-hooks.local.json",
  ".config/agent-hooks.local.json5",
  "agent-hooks.local.yml",
  "agent-hooks.local.yaml",
  "agent-hooks.local.json",
  "agent-hooks.local.json5",
];

export interface LoadedConfig {
  readonly config: Config;
  readonly sourcePath: string;
  readonly localPath: string | null;
}

export interface LoadOptions {
  readonly cwd?: string;
  readonly configPath?: string | undefined;
  /** Optional filesystem abstraction so tests don't need tmpdirs. */
  readonly fs?: LoaderFs;
}

export interface LoaderFs {
  exists(filePath: string): Promise<boolean>;
  read(filePath: string): Promise<string>;
}

const defaultFs: LoaderFs = {
  async exists(filePath) {
    return Bun.file(filePath).exists();
  },
  async read(filePath) {
    return Bun.file(filePath).text();
  },
};

/**
 * Parse raw text into an unknown JS value based on the file extension.
 * YAML for .yml/.yaml, JSON5 for .json5, plain JSON otherwise.
 */
export function parseConfigText(source: string, filePath: string): unknown {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".yml" || ext === ".yaml") {
      return YAML.parse(source);
    }
    if (ext === ".json5") {
      return JSON5.parse(source);
    }
    return JSON.parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Failed to parse ${filePath}`, {
      path: filePath,
      details: message,
    });
  }
}

/**
 * Format a ZodError into a readable, multi-line message. Callers wrap this
 * in a ConfigError so the caller's try/catch stays uniform.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${at}: ${issue.message}`;
    })
    .join("\n");
}

async function findFirst(
  cwd: string,
  candidates: readonly string[],
  fs: LoaderFs,
): Promise<string | null> {
  // Walk from cwd up to the filesystem root, checking each candidate
  // at each level. Catches `agent-hooks` invoked from any subdir of
  // a project — the config lives at the repo root but works from
  // anywhere inside.
  let dir = path.resolve(cwd);
  for (;;) {
    for (const rel of candidates) {
      const abs = path.join(dir, rel);
      if (await fs.exists(abs)) return abs;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function loadConfig(
  options: LoadOptions = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const fs = options.fs ?? defaultFs;

  const sourcePath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : await findFirst(cwd, CONFIG_CANDIDATES, fs);

  if (!sourcePath) {
    throw new ConfigNotFoundError(
      cwd,
      CONFIG_CANDIDATES.map((c) => path.join(cwd, c)),
    );
  }

  if (options.configPath && !(await fs.exists(sourcePath))) {
    throw new ConfigError(`Config file not found: ${sourcePath}`, {
      path: sourcePath,
    });
  }

  const baseRaw = parseConfigText(await fs.read(sourcePath), sourcePath);
  const localPath = await findFirst(cwd, LOCAL_OVERRIDES, fs);
  const merged = localPath
    ? deepMerge(
        baseRaw,
        parseConfigText(await fs.read(localPath), localPath),
      )
    : baseRaw;

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config in ${sourcePath}`, {
      path: sourcePath,
      details: formatZodError(parsed.error),
    });
  }

  return {
    config: parsed.data,
    sourcePath,
    localPath,
  };
}
