import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import { AGENT_HANDLERS } from "../hooks/registry.ts";
import type { AgentDetection, AgentFs, AgentHandler } from "../hooks/types.ts";
import {
  statusAgentsMdBlock,
  type AgentsMdFs,
} from "../integrations/agents-md/install.ts";
import { configHash } from "../integrations/git/hash.ts";
import {
  defaultHookFs,
  installHooks,
  type HookFs,
} from "../integrations/git/install.ts";
import { inspectStub } from "../integrations/git/stub.ts";
import { createGitRunner, type GitRunner } from "../runners/files.ts";
import { detectPlaywrightCheckpoint } from "../reporters/prompts.ts";
import {
  defaultEnvResolver,
  resolveEnvironment,
  type EnvResolver,
} from "../runners/env-resolution.ts";
import {
  defaultPreflightResolver,
  evaluatePreflight,
  resolvePreflightPolicy,
  type PreflightResolver,
} from "../runners/preflight.ts";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const KNOWN_PLAYWRIGHT_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const PLAYWRIGHT_FILES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
] as const;

const PLAYWRIGHT_DOC_URL = "https://github.com/pm990320/playwright-checkpoint";

interface GitStatusEntry {
  readonly hook: string;
  readonly status: HookHealth;
}

type HookHealth = "ok" | "missing" | "wrong-hash" | "foreign" | "error";

interface DoctorState {
  readonly suppressPlaywrightCheckpointWarning: boolean;
};

interface DefaultHookFs {
  readonly exists: (p: string) => Promise<boolean>;
  readonly read: (p: string) => Promise<string>;
  readonly write: (p: string, contents: string, mode: number) => Promise<void>;
  readonly mkdirRecursive: (p: string) => Promise<void>;
}

const DEFAULT_HOOK_FILEMODE = 0o644;

function makeDefaultAgentFs(fs: DefaultHookFs): AgentFs {
  return {
    exists: (p) => fs.exists(p),
    read: (p) => fs.read(p),
    write: (p, contents) => fs.write(p, contents, DEFAULT_HOOK_FILEMODE),
    mkdirRecursive: (p) => fs.mkdirRecursive(p),
  };
}

function expectedHooks(config: Config): string[] {
  if (!config.git?.hooks) return [];
  return Object.entries(config.git.hooks)
    .filter(([, cfg]) => cfg !== undefined)
    .map(([name]) => name)
    .sort();
}

async function fileExistsAt(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await fs.readFile(p, "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasPlaywrightDependency(record: Record<string, unknown>): boolean {
  for (const key of KNOWN_PLAYWRIGHT_KEYS) {
    const section = record[key];
    if (
      typeof section === "object" &&
      section !== null &&
      Object.prototype.hasOwnProperty.call(section, "playwright")
    ) {
      return true;
    }
  }
  return false;
}

async function detectPlaywrightDefault(cwd: string): Promise<boolean> {
  const pkg = await readJsonObject(path.join(cwd, "package.json"));
  if (pkg && hasPlaywrightDependency(pkg)) return true;
  for (const name of PLAYWRIGHT_FILES) {
    if (await fileExistsAt(path.join(cwd, name))) return true;
  }
  return false;
}

function classifyHookStatus(
  status: HookHealth,
): { readonly marker: string; readonly detail: string } {
  if (status === "ok") return { marker: "✓", detail: "stub present" };
  if (status === "missing") return { marker: "⊘", detail: "stub missing" };
  if (status === "wrong-hash") return { marker: "⚠", detail: "hash mismatch" };
  if (status === "foreign") return { marker: "⊗", detail: "foreign file found" };
  return { marker: "⚠", detail: "unreadable" };
}

async function inspectGitHooks(
  config: Config,
  gitRoot: string,
  fs: HookFs,
): Promise<readonly GitStatusEntry[]> {
  const currentHash = configHash(config);
  const hooks = expectedHooks(config);
  const statuses: GitStatusEntry[] = [];

  for (const hook of hooks) {
    const p = path.join(gitRoot, ".git", "hooks", hook);
    const exists = await fs.exists(p);
    if (!exists) {
      statuses.push({ hook, status: "missing" });
      continue;
    }
    try {
      const raw = await fs.read(p);
      const inspected = inspectStub(raw);
      if (!inspected.managed) {
        statuses.push({ hook, status: "foreign" });
        continue;
      }
      statuses.push({
        hook,
        status:
          inspected.configHash === currentHash ? "ok" : "wrong-hash",
      });
    } catch {
      statuses.push({ hook, status: "error" });
    }
  }

  return statuses;
}

function summarizeHookStates(
  states: readonly GitStatusEntry[],
): { readonly allGood: boolean; readonly hasForeign: boolean } {
  let allGood = true;
  let hasForeign = false;
  for (const state of states) {
    if (state.status !== "ok") allGood = false;
    if (state.status === "foreign") hasForeign = true;
  }
  return { allGood, hasForeign };
}

async function maybe<T>(
  runner: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await runner();
  } catch {
    return fallback;
  }
}

async function reportAgentIntegrations(
  handlers: readonly AgentHandler[],
  deps: DoctorDeps,
  agentFs: AgentFs,
  homeDir: string,
): Promise<void> {
  deps.write("Agent integrations:\n");
  for (const handler of handlers) {
    const detection: AgentDetection = await handler.detect(
      deps.cwd,
      homeDir,
      agentFs,
    );
    const marker = detection.present ? "✓" : "⊘";
    const scope = detection.scope ? ` [${detection.scope}]` : "";
    const where = detection.path ? ` ${detection.path}` : "";
    deps.write(
      `  ${marker} ${handler.name.padEnd(14)} ${handler.displayName}${scope}${where}\n`,
    );
  }
}

export interface DoctorDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly gitRoot?: GitRunner;
  readonly makeGit?: (cwd: string) => GitRunner;
  readonly hookFs?: HookFs;
  readonly homeDir?: string;
  readonly agentFs?: AgentFs;
  readonly agentHandlers?: readonly AgentHandler[];
  readonly detectPlaywright?: (cwd: string) => Promise<boolean>;
  readonly detectPlaywrightCheckpoint?: (cwd: string) => Promise<boolean>;
  /** Enable remediation for every supported check. */
  readonly fix?: boolean;
  /** Suppress one-off warnings (notably Playwright promotion). */
  readonly quiet?: boolean;
  /** Override the preflight resolver in tests. */
  readonly preflightResolver?: PreflightResolver;
  /** Override the env-resolver in tests. `null` skips env reporting. */
  readonly envResolver?: EnvResolver | null;
  /** Base env to feed into env-resolution. Defaults to `process.env`. */
  readonly env?: Record<string, string>;
  /** Override the CLAUDE.md / AGENTS.md fs adapter; `null` skips the section. */
  readonly agentsMdFs?: AgentsMdFs | null;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly exitCode: number;
}

/**
 * Run the doctor checks and write their output via the injected writers.
 * Pure-ish: no process.* access, so tests can capture output directly.
 *
 * At M1 scope this covers:
 *   1. Config file found and loaded.
 *   2. Schema-valid (already enforced by the loader).
 *   3. Pipelines only reference defined steps.
 *
 * Future milestones extend this with git-hook install checks,
 * environment resolution, preflight, and agent-integration checks.
 */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  let loaded: LoadedConfig;
  try {
    loaded = await deps.load(deps.cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return { ok: false, exitCode: 2 };
    }
    throw err;
  }

  deps.write(`✓ Config loaded: ${loaded.sourcePath}\n`);
  if (loaded.localPath) {
    deps.write(`  + local override: ${loaded.localPath}\n`);
  }

  const stepNames = Object.keys(loaded.config.steps);
  const pipelineNames = Object.keys(loaded.config.pipelines);
  deps.write(
    `✓ Schema valid — ${String(stepNames.length)} steps, ${String(pipelineNames.length)} pipelines\n`,
  );

  const undefinedRefs: string[] = [];
  for (const [pipeName, pipeline] of Object.entries(loaded.config.pipelines)) {
    for (const stepName of pipeline.steps) {
      if (!(stepName in loaded.config.steps)) {
        undefinedRefs.push(`pipelines.${pipeName} → ${stepName}`);
      }
    }
  }

  if (undefinedRefs.length > 0) {
    deps.writeErr(`✗ Pipelines reference undefined steps:\n`);
    for (const ref of undefinedRefs) deps.writeErr(`  - ${ref}\n`);
    return { ok: false, exitCode: 2 };
  }

  deps.write(`✓ All pipeline step references resolve\n`);

  // Determine global per-run behavior.
  const state: DoctorState = {
    suppressPlaywrightCheckpointWarning:
      deps.quiet === true ||
      loaded.config.doctor?.suppress?.includes("playwright-checkpoint") === true,
  };
  const hookFs = deps.hookFs ?? defaultHookFs;
  const gitRunner: GitRunner = deps.gitRoot ??
    (deps.makeGit ?? createGitRunner)(deps.cwd);
  const homeDir = deps.homeDir ?? os.homedir();
  const agentFs = deps.agentFs ??
    makeDefaultAgentFs({
      exists: (p) => defaultHookFs.exists(p),
      read: (p) => defaultHookFs.read(p),
      write: (p, c) => defaultHookFs.write(p, c, DEFAULT_HOOK_FILEMODE),
      mkdirRecursive: (p) => defaultHookFs.mkdirRecursive(p),
    });
  const handlers = deps.agentHandlers ?? AGENT_HANDLERS;
  const detectPlaywright = deps.detectPlaywright ?? detectPlaywrightDefault;
  const detectPlaywrightCheckpointFn =
    deps.detectPlaywrightCheckpoint ?? detectPlaywrightCheckpoint;

  // Git-hook wiring checks: missing hooks, foreign stubs, config-hash drift.
  const configuredHooks = expectedHooks(loaded.config);
  if (configuredHooks.length === 0) {
    deps.write("Git hooks: no hooks configured\n");
  } else {
    const gitRoot = await maybe(
      async () => (await gitRunner.gitRoot?.()) ?? null,
      null,
    );
    if (gitRoot === null) {
      deps.writeErr("⚠ Git hooks: not inside a git repository\n");
    } else {
      const hookStatuses = await inspectGitHooks(loaded.config, gitRoot, hookFs);
      deps.write("Git hooks:\n");
      for (const entry of hookStatuses) {
        const marker = classifyHookStatus(entry.status);
        const pathHint = path.join(gitRoot, ".git", "hooks", entry.hook);
        deps.write(`  ${marker.marker} ${entry.hook.padEnd(14)} ${marker.detail} (${pathHint})\n`);
      }
      const { allGood } = summarizeHookStates(hookStatuses);
      if (deps.fix === true && !allGood) {
        const result = await installHooks({
          gitRoot,
          config: loaded.config,
          fs: hookFs,
          foreignHookPolicy: "replace",
        });
        deps.write("  ↳ fix: applied git hook remediations\n");
        for (const outcome of result.outcomes) {
          deps.write(`    - ${outcome.hookName}: ${outcome.status}\n`);
        }
      }
    }
  }

  // Agent integrations: list every registered handler and whether it
  // appears to be installed.
  await reportAgentIntegrations(handlers, deps, agentFs, homeDir);

  // Preflight every step's `requires:` block. Hard requirements (no
  // on-missing override or `on-missing: fail`) trip the exit code;
  // soft requirements (warn / warn-skip / skip) emit a note but
  // don't fail. Steps with no requires are silent.
  const resolver = deps.preflightResolver ?? defaultPreflightResolver;
  let preflightOk = true;
  let anyPreflightChecked = false;
  for (const [stepName, step] of Object.entries(loaded.config.steps)) {
    if (step.requires.length === 0) continue;
    anyPreflightChecked = true;
    const decision = await evaluatePreflight(step, deps.cwd, resolver);
    if (decision.ok) continue;
    const policy = resolvePreflightPolicy(step, "manual");
    const reasons = decision.failures.map((f) => f.reason).join("; ");
    if (policy === "fail") {
      preflightOk = false;
      deps.writeErr(`✗ ${stepName}: preflight failed — ${reasons}\n`);
    } else {
      deps.write(`  ⚠ ${stepName}: preflight (${policy}) — ${reasons}\n`);
    }
  }
  if (anyPreflightChecked && preflightOk) {
    deps.write(`✓ All step preflight checks resolve\n`);
  }
  if (!preflightOk) {
    return { ok: false, exitCode: 2 };
  }

  // Environment resolution: report which auto layers (direnv, mise, asdf,
  // venv, node_modules/.bin) fired. Purely informational — never fails
  // the run. `envResolver: null` opts out of this section entirely.
  if (deps.envResolver !== null) {
    const envResolver = deps.envResolver ?? defaultEnvResolver;
    const baseEnv = deps.env ?? (process.env as Record<string, string>);
    const resolvedEnv = await resolveEnvironment(
      {
        cwd: deps.cwd,
        baseEnv,
        ...(loaded.config.env ? { configEnv: loaded.config.env } : {}),
      },
      envResolver,
    );
    const meaningful = resolvedEnv.sources.filter((s) => s.kind !== "process");
    if (meaningful.length === 0) {
      deps.write(`✓ Environment: no auto-resolution layers fired\n`);
    } else {
      deps.write(`✓ Environment auto-resolution:\n`);
      for (const source of meaningful) {
        const detail = source.detail ? ` — ${source.detail}` : "";
        deps.write(
          `  • ${source.kind} (${String(source.keysApplied)} keys)${detail}\n`,
        );
      }
    }
    for (const note of resolvedEnv.notes) {
      deps.write(`  ⚠ ${note}\n`);
    }
  }

  // Agent-hooks marker block presence in CLAUDE.md / AGENTS.md. Purely
  // informational — surfaces drift after an upgrade so users know to
  // run `agent-hooks agent instructions install` to refresh the block.
  if (deps.agentsMdFs !== null) {
    const amFs: AgentsMdFs =
      deps.agentsMdFs ??
      ({
        exists: async (p) => {
          try {
            await fs.access(p);
            return true;
          } catch {
            return false;
          }
        },
        read: (p) => fs.readFile(p, "utf8"),
        write: (p, contents) => fs.writeFile(p, contents, "utf8"),
      } satisfies AgentsMdFs);
    const entries = await statusAgentsMdBlock({
      cwd: deps.cwd,
      fs: amFs,
    });
    const interesting = entries.filter((e) => e.exists);
    if (interesting.length > 0) {
      deps.write("agent-hooks instructions:\n");
      for (const entry of interesting) {
        if (!entry.blockPresent) {
          deps.write(
            `  · ${entry.path} — no block (run 'agent-hooks agent instructions install' to add)\n`,
          );
        } else if (!entry.inSync) {
          deps.write(
            `  ⚠ ${entry.path} — stale (run 'agent-hooks agent instructions install' to refresh)\n`,
          );
        } else {
          deps.write(`  ✓ ${entry.path} — in sync\n`);
        }
      }
    }
  }

  // Playwright / Playwright-Checkpoint integration.
  const isPlaywright = await maybe(() => detectPlaywright(deps.cwd), false);
  const hasCheckpoint = await maybe(
    () => detectPlaywrightCheckpointFn(deps.cwd),
    false,
  );
  if (isPlaywright) {
    deps.write("Playwright-Checkpoint:\n");
    if (hasCheckpoint) {
      deps.write("  ✓ detected — prompts will include checkpoint review guidance\n");
      deps.write(
        "  ✓ report output: ./report/index.html\n  ✓ checkpoint artifacts: test-results/checkpoints/\n",
      );
      deps.write(
        "  ↳ Playwright-Checkpoint is active for richer e2e artifacts\n",
      );
    } else if (!state.suppressPlaywrightCheckpointWarning) {
      deps.write(
        "⚠ Playwright detected without playwright-checkpoint\n",
      );
      deps.write(
        "  → playwright-checkpoint captures screenshots, accessibility audits,\n",
      );
      deps.write("    web vitals, and console/network errors per checkpoint.\n");
      deps.write(
        `  → install with: bun add -d playwright-checkpoint\n  → see: ${PLAYWRIGHT_DOC_URL}\n`,
      );
    }
  }

  return { ok: true, exitCode: 0 };
}

export const defaultDoctorDeps: Omit<DoctorDeps, "cwd"> = {
  write: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
  load: (cwd) => {
    return loadConfig({ cwd });
  },
  makeGit: createGitRunner,
  hookFs: defaultHookFs,
  homeDir: os.homedir(),
  agentFs: makeDefaultAgentFs({
    exists: (p) => defaultHookFs.exists(p),
    read: (p) => defaultHookFs.read(p),
    write: (p, c) => defaultHookFs.write(p, c, DEFAULT_HOOK_FILEMODE),
    mkdirRecursive: (p) => defaultHookFs.mkdirRecursive(p),
  }),
  agentHandlers: AGENT_HANDLERS,
  detectPlaywright: detectPlaywrightDefault,
  detectPlaywrightCheckpoint: detectPlaywrightCheckpoint,
};

export function registerDoctorCommand(
  program: Command,
  overrides: Partial<DoctorDeps> = {},
): Command {
  return program
    .command("doctor")
    .description("Validate the agent-hooks config and report problems")
    .option("--fix", "auto-remediate supported checks (hooks, venv hints)")
    .option("--quiet", "suppress one-off warnings")
    .action(async function (this: Command) {
      const flags: {
        fix?: boolean;
        quiet?: boolean;
      } = this.opts();
      const deps: DoctorDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultDoctorDeps.write,
        writeErr: overrides.writeErr ?? defaultDoctorDeps.writeErr,
        load: overrides.load ?? defaultDoctorDeps.load,
        ...(overrides.preflightResolver
          ? { preflightResolver: overrides.preflightResolver }
          : {}),
        ...("agentsMdFs" in overrides
          ? { agentsMdFs: overrides.agentsMdFs }
          : {}),
        ...("envResolver" in overrides
          ? { envResolver: overrides.envResolver }
          : {}),
        ...(overrides.env ? { env: overrides.env } : {}),
        ...(flags.fix ? { fix: true } : {}),
        ...(flags.quiet ? { quiet: true } : {}),
        ...(overrides.makeGit ? { makeGit: overrides.makeGit } : {}),
        ...(overrides.hookFs ? { hookFs: overrides.hookFs } : {}),
        ...(overrides.homeDir ? { homeDir: overrides.homeDir } : {}),
        ...(overrides.agentFs ? { agentFs: overrides.agentFs } : {}),
        ...(overrides.agentHandlers
          ? { agentHandlers: overrides.agentHandlers }
          : {}),
        ...(overrides.detectPlaywright
          ? { detectPlaywright: overrides.detectPlaywright }
          : {}),
        ...(overrides.detectPlaywrightCheckpoint
          ? { detectPlaywrightCheckpoint: overrides.detectPlaywrightCheckpoint }
          : {}),
      };
      const report = await runDoctor(deps);
      if (!report.ok) throw new ExitError(report.exitCode);
    });
}
