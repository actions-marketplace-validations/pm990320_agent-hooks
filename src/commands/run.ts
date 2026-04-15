import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import type { Config, Pipeline } from "../config/schema.ts";
import { pickReporter, type Reporter } from "../reporters/index.ts";
import {
  detectPromptContext,
  pickPromptPolicy,
  detectPlaywrightCheckpoint,
  type PromptContext,
  renderNextStepBlock,
  shouldEmitPrompt,
} from "../reporters/prompts.ts";
import {
  defaultEnvResolver,
  resolveEnvironment,
  type EnvResolver,
} from "../runners/env-resolution.ts";
import {
  diffArtifacts,
  effectiveArtifactInputs,
  snapshotArtifacts,
  type ArtifactSnapshot,
} from "../reporters/artifacts.ts";
import { stepDurationSeconds } from "../reporters/format.ts";
import {
  createGitRunner,
  defaultSpawner,
  PathOutsideRepoError,
  resolveFiles,
  type GitRunner,
  type Scope,
} from "../runners/files.ts";
import { runPipeline } from "../runners/pipeline.ts";
import { registerChild } from "../runners/process-registry.ts";
import { resolveSkipDirectives } from "../runners/skip-directives.ts";
import type { ExecFn } from "../runners/step.ts";
import type { StepOutcome } from "../runners/pipeline.ts";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// --- Public shape --------------------------------------------------------

export interface RunCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly makeGit: (cwd: string) => GitRunner;
  readonly exec: ExecFn;
  readonly env: Record<string, string>;
  /** Override the reporter selection — defaults to `pickReporter` on env. */
  readonly reporter?: Reporter;
  /**
   * Override the env-resolution layers (direnv/mise/asdf/venv/node-bin).
   * Tests inject a fake resolver so they don't shell out. Setting this
   * to `null` skips the auto-resolution layer entirely — useful for
   * tests that want to assert the un-augmented base env reaches the
   * runner.
   */
  readonly envResolver?: EnvResolver | null;
}

export interface RunArgs {
  readonly target: string;
  readonly explicitFiles?: readonly string[];
  readonly changed?: boolean;
  readonly staged?: boolean;
  readonly all?: boolean;
  readonly skip?: readonly string[];
  readonly only?: readonly string[];
  readonly jobs?: number;
  readonly forceGates?: boolean;
  /**
   * Suppress the per-step `---agent-hooks:next-step---` prompt blocks.
   * Use when piping output into a tool that doesn't need the guidance.
   */
  readonly noPrompts?: boolean;
  /**
   * Force a specific prompt emission context. Normally detected from
   * env (agent/ci/tty). Useful for tests and for users who want agent
   * prompts in a plain TTY.
   */
  readonly promptContext?: PromptContext;
  /**
   * Skip the path-boundary check on `--files`. By default any path
   * outside the repo root is rejected. Documented as a footgun in
   * the CLI help — most users never need this.
   */
  readonly allowOutsideRepo?: boolean;
}

// --- Scope resolution ----------------------------------------------------

/**
 * Pick the effective scope from CLI flags. Explicit `--files` wins over
 * every flag. After that, the most specific flag wins. With nothing set,
 * we default to `changed` — what agents and developers usually want.
 */
export function pickScope(args: RunArgs): Scope {
  if (args.explicitFiles && args.explicitFiles.length > 0) return "explicit";
  if (args.all) return "all";
  if (args.staged) return "staged";
  if (args.changed) return "changed";
  return "changed";
}

// --- Target resolution ---------------------------------------------------

/**
 * Resolve `<target>` as either a pipeline or a single step. When the target
 * is a step name, synthesize a one-step pipeline so the pipeline runner
 * can handle both uniformly.
 */
export function resolveTarget(
  config: Config,
  target: string,
): { config: Config; pipelineName: string } | null {
  if (target in config.pipelines) {
    return { config, pipelineName: target };
  }
  if (target in config.steps) {
    const synthetic: Pipeline = {
      steps: [target],
      parallel: false,
      "exclude-tags": [],
      "include-tags": [],
      "continue-on-error": false,
    };
    return {
      config: {
        ...config,
        pipelines: {
          ...config.pipelines,
          __agent_hooks_single__: synthetic,
        },
      },
      pipelineName: "__agent_hooks_single__",
    };
  }
  return null;
}

// --- Core action ---------------------------------------------------------

export async function runCommand(
  args: RunArgs,
  deps: RunCommandDeps,
): Promise<number> {
  let loaded: LoadedConfig;
  try {
    loaded = await deps.load(deps.cwd);
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }

  const resolved = resolveTarget(loaded.config, args.target);
  if (!resolved) {
    deps.writeErr(
      `✗ unknown pipeline or step: "${args.target}"\n` +
        `  known pipelines: ${Object.keys(loaded.config.pipelines).join(", ") || "(none)"}\n` +
        `  known steps:     ${Object.keys(loaded.config.steps).join(", ") || "(none)"}\n`,
    );
    return 2;
  }

  const scope = pickScope(args);
  // Re-anchor at the git root so `agent-hooks ci --all` invoked from
  // a subdir doesn't see a partial file list. `git ls-files` from a
  // subdir only reports paths under that subdir, which silently hides
  // files outside it. We swap to the toplevel and use that as the
  // effective cwd for both file resolution and step execution.
  const initialGit = deps.makeGit(deps.cwd);
  const repoRoot =
    (initialGit.gitRoot && (await initialGit.gitRoot())) ?? deps.cwd;
  const effectiveCwd = repoRoot;
  const git =
    effectiveCwd === deps.cwd ? initialGit : deps.makeGit(effectiveCwd);
  let files;
  try {
    files = await resolveFiles(git, {
      scope,
      ...(args.explicitFiles ? { files: args.explicitFiles } : {}),
      repoRoot: effectiveCwd,
      ...(args.allowOutsideRepo ? { allowOutsideRepo: true } : {}),
    });
  } catch (err) {
    if (err instanceof PathOutsideRepoError) {
      deps.writeErr(`✗ ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const reporter =
    deps.reporter ?? pickReporter({ env: deps.env, write: deps.write });

  // Layer skip directives: CLI > env > commit message. The resolver
  // produces unified skip + only sets that we hand to the runner. If
  // skipAll fires we short-circuit by setting skip to every step.
  // Reading HEAD's commit message is best-effort: a fresh repo or a
  // non-git cwd just yields `null` and the layer no-ops.
  let commitMessage: string | null = null;
  if (git.commitMessage) {
    try {
      commitMessage = await git.commitMessage();
    } catch {
      commitMessage = null;
    }
  }
  const directives = resolveSkipDirectives({
    ...(args.skip ? { cliSkip: args.skip } : {}),
    ...(args.only ? { cliOnly: args.only } : {}),
    env: deps.env,
    ...(commitMessage ? { commitMessage } : {}),
  });

  let effectiveSkip = directives.skip;
  if (directives.skipAll) {
    effectiveSkip = new Set(Object.keys(resolved.config.steps));
    deps.write(
      `  ⊘ skipping all steps (skipAll directive from ${
        directives.sources[directives.sources.length - 1]?.from.kind ?? "config"
      })\n`,
    );
  }

  // Resolve the effective environment by layering direnv, mise/asdf,
  // venv, and node_modules/.bin on top of the base env. The user's
  // top-level `env:` block wins last. Setting `envResolver: null`
  // disables the auto-resolution layers entirely (used by tests that
  // want to assert the un-augmented env reaches the runner).
  let pipelineEnv = deps.env;
  if (deps.envResolver !== null) {
    const resolverImpl = deps.envResolver ?? defaultEnvResolver;
    const resolvedEnv = await resolveEnvironment(
      {
        cwd: effectiveCwd,
        baseEnv: deps.env,
        ...(loaded.config.env ? { configEnv: loaded.config.env } : {}),
      },
      resolverImpl,
    );
    pipelineEnv = resolvedEnv.env;
    // Surface non-process layers as a single line so users see what
    // fired without having to grep for it. Process is always layer 1
    // and isn't worth printing.
    const meaningful = resolvedEnv.sources.filter((s) => s.kind !== "process");
    if (meaningful.length > 0) {
      const summary = meaningful
        .map((s) => `${s.kind}(${String(s.keysApplied)})`)
        .join(" ");
      deps.write(`  ↳ env: ${summary}\n`);
    }
    for (const note of resolvedEnv.notes) {
      deps.write(`  ⚠ env: ${note}\n`);
    }
  }

  const promptContext: PromptContext =
    args.promptContext ?? detectPromptContext(deps.env);
  const promptPolicy = pickPromptPolicy(promptContext, args.noPrompts ?? false);
  const artifactBaseline = new Map<string, ArtifactSnapshot>();
  const playwrightCheckpoint = await detectPlaywrightCheckpoint(effectiveCwd);
  const ciReportLines: string[] = [];
  const buildArtifactsReport = (stepName: string, before: ArtifactSnapshot, after: ArtifactSnapshot): string[] =>
    diffArtifacts(before, after).filter((path) => {
      const step = resolved.config.steps[stepName];
      const candidates = effectiveArtifactInputs(step?.artifacts);
      return candidates.some((candidate) => path.startsWith(candidate));
    }).sort();

  function yamlEscape(value: string): string {
    if (value.length === 0) return '""';
    if (/[\n:#"]/.test(value) || /^\s/.test(value) || /\s$/.test(value)) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  function writeCiReport(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const reportPath = resolve(effectiveCwd, "agent-hooks-report.yml");
    const body = ["steps:"]
      .concat(lines)
      .join("\n")
      .concat("\n");
    writeFileSync(reportPath, body, "utf8");
  }

  function buildCiReportEntry(
    outcome: StepOutcome,
    artifacts: readonly string[],
  ): string[] {
    const files = (outcome.result?.files ?? []).join(" ");
    const lines: string[] = [];
    lines.push(`- step: ${yamlEscape(outcome.name)}`);
    lines.push("  status: failed");
    lines.push(`  exit_code: ${String(outcome.result?.exitCode ?? 0)}`);
    lines.push(`  duration: ${String(stepDurationSeconds(outcome) ?? 0)}s`);
    lines.push(`  summary: ${yamlEscape(outcome.result?.reason ?? "failed")}`);
    if (files.length > 0) {
      lines.push("  files:");
      for (const file of outcome.result?.files ?? []) {
        lines.push(`    - ${yamlEscape(file)}`);
      }
    } else {
      lines.push("  files: []");
    }
    if (artifacts.length > 0) {
      lines.push("  artifacts:");
      for (const artifact of artifacts) {
        lines.push(`    - ${yamlEscape(artifact)}`);
      }
    } else {
      lines.push("  artifacts: []");
    }
    return lines;
  }

  reporter.pipelineStart(resolved.pipelineName);
  const result = await runPipeline(
    {
      pipelineName: resolved.pipelineName,
      config: resolved.config,
      files: files.files,
      cwd: effectiveCwd,
      env: pipelineEnv,
      git,
      ...(effectiveSkip.size > 0 ? { skip: effectiveSkip } : {}),
      ...(directives.only.size > 0 ? { only: directives.only } : {}),
      ...(args.jobs !== undefined ? { jobs: args.jobs } : {}),
      ...(args.forceGates ? { forceGates: true } : {}),
      onStepStart: (info) => {
        reporter.stepStart(info);
        const step = resolved.config.steps[info.name];
        if (!step) return;
        const candidates = effectiveArtifactInputs(step.artifacts);
        const before = snapshotArtifacts(effectiveCwd, candidates);
        artifactBaseline.set(info.name, before);
      },
      onStepEnd: (outcome) => {
        reporter.stepEnd(outcome);
        const step = resolved.config.steps[outcome.name];
        if (step) {
          const candidates = effectiveArtifactInputs(step.artifacts);
          const before = artifactBaseline.get(outcome.name) ?? new Map();
          const after = snapshotArtifacts(effectiveCwd, candidates);
          const artifacts = buildArtifactsReport(
            outcome.name,
            before,
            after,
          );
          if (shouldEmitPrompt(outcome, promptPolicy)) {
            deps.writeErr(
              renderNextStepBlock({
                outcome,
                step,
                cwd: effectiveCwd,
                files: outcome.result?.files ?? [],
                playwrightCheckpoint,
                artifacts,
              }),
            );
          }
          if (
            promptContext === "ci" &&
            outcome.result?.status === "failed"
          ) {
            const lines = buildCiReportEntry(outcome, artifacts);
            if (lines.length > 0) ciReportLines.push(...lines);
          }
        }
      },
    },
    deps.exec,
  );
  if (promptContext === "ci" && ciReportLines.length > 0) {
    writeCiReport(ciReportLines);
  }
  reporter.pipelineEnd(result);
  return result.exitCode;
}

// --- Commander registration ---------------------------------------------

export const defaultRunDeps: Omit<RunCommandDeps, "cwd" | "env"> & {
  readonly env: Record<string, string>;
} = {
  write(text) {
    process.stdout.write(text);
  },
  writeErr(text) {
    process.stderr.write(text);
  },
  load(cwd) {
    return loadConfig({ cwd });
  },
  makeGit(cwd) {
    return createGitRunner(cwd, defaultSpawner);
  },
  async exec({ command, cwd, env, stdin, output, timeoutMs }) {
    const start = Date.now();
    // `inherit` is the right default for the most common case: a
    // sequential pipeline whose output the user wants to see live.
    // The pipeline runner picks `buffered` for parallel pipelines.
    //
    // Test harnesses that need to capture step output via
    // process.stdout.write swapping (see test/integration/support/cli.ts)
    // set AGENT_HOOKS_FORCE_OUTPUT_MODE=buffered to opt every step into
    // buffered mode regardless of the pipeline runner's choice.
    const forced = process.env.AGENT_HOOKS_FORCE_OUTPUT_MODE;
    const mode: "inherit" | "buffered" =
      forced === "buffered" || forced === "inherit"
        ? forced
        : (output ?? "inherit");

    function runWithTimeout(
      proc: { exited: Promise<number>; kill: (signal?: NodeJS.Signals) => void },
    ): Promise<{ exitCode: number; timedOut: boolean }> {
      if (timeoutMs === undefined || timeoutMs <= 0) {
        return proc.exited.then((code) => ({ exitCode: code, timedOut: false }));
      }
      return new Promise((resolve) => {
        let settled = false;
        const finish = (exitCode: number, timedOut: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({ exitCode, timedOut });
        };
        const termTimer = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // already dead
          }
          // Give the child a moment to clean up, then SIGKILL.
          const killTimer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, 1000);
          (killTimer as unknown as { unref?: () => void }).unref?.();
        }, timeoutMs);
        (termTimer as unknown as { unref?: () => void }).unref?.();
        void proc.exited.then((code) => {
          clearTimeout(termTimer);
          // exit code 124 is the conventional "timed out" code (GNU
          // timeout). Use it whenever we hit the deadline regardless
          // of what the child actually returned.
          if (Date.now() - start >= timeoutMs) {
            finish(124, true);
          } else {
            finish(code, false);
          }
        });
      });
    }

    if (mode === "inherit") {
      // Stream child stdio straight through to the parent. Test
      // harnesses that need to capture output should set output:
      // 'buffered' explicitly (or rely on the pipeline runner doing
      // it for parallel pipelines).
      const proc = Bun.spawn({
        cmd: ["sh", "-c", command],
        cwd,
        env,
        stdin: stdin !== undefined ? "pipe" : "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const dispose = registerChild(proc);
      try {
        if (stdin !== undefined && proc.stdin) {
          await proc.stdin.write(stdin);
          await proc.stdin.end();
        }
        const { exitCode, timedOut } = await runWithTimeout(proc);
        return {
          exitCode,
          durationMs: Date.now() - start,
          ...(timedOut ? { timedOut: true } : {}),
        };
      } finally {
        dispose();
      }
    }

    // buffered: capture stdout/stderr in memory so two parallel
    // siblings don't interleave on the parent's FDs, then flush
    // atomically on completion.
    const proc = Bun.spawn({
      cmd: ["sh", "-c", command],
      cwd,
      env,
      stdin: stdin !== undefined ? "pipe" : "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const dispose = registerChild(proc);
    try {
      if (stdin !== undefined && proc.stdin) {
        await proc.stdin.write(stdin);
        await proc.stdin.end();
      }
      const [stdoutText, stderrText, { exitCode, timedOut }] =
        await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          runWithTimeout(proc),
        ]);
      if (stdoutText.length > 0) process.stdout.write(stdoutText);
      if (stderrText.length > 0) process.stderr.write(stderrText);
      return {
        exitCode,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      };
    } finally {
      dispose();
    }
  },
  // Read process.env on every access so tests that temporarily set
  // env vars (e.g. GITHUB_ACTIONS) actually take effect.
  get env(): Record<string, string> {
    return { ...(process.env as Record<string, string>) };
  },
};

function commaSplit(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface RegisterOptions {
  readonly overrides?: Partial<RunCommandDeps>;
}

function effectiveDeps(
  overrides: Partial<RunCommandDeps> | undefined,
): RunCommandDeps {
  const base: RunCommandDeps = {
    cwd: overrides?.cwd ?? process.cwd(),
    write: overrides?.write ?? defaultRunDeps.write,
    writeErr: overrides?.writeErr ?? defaultRunDeps.writeErr,
    load: overrides?.load ?? defaultRunDeps.load,
    makeGit: overrides?.makeGit ?? defaultRunDeps.makeGit,
    exec: overrides?.exec ?? defaultRunDeps.exec,
    env: overrides?.env ?? defaultRunDeps.env,
  };
  if (
    overrides &&
    "envResolver" in overrides &&
    overrides.envResolver !== undefined
  ) {
    return { ...base, envResolver: overrides.envResolver };
  }
  return base;
}

/**
 * Shared option + action wiring used by `run`, `ci`, and the shortcut
 * commands. Takes a function that maps CLI args → target name so `ci`
 * and the shortcuts can pin a specific target.
 */
function addRunnerOptions(
  cmd: Command,
  targetFrom: (positional: string | undefined) => string,
  opts: RegisterOptions,
): Command {
  // Commander's action callback signature depends on whether the command
  // declares a positional argument: `(positional, flags, command)` vs
  // `(flags, command)`. We read flags via `this.opts()` and positionals
  // from `args` to make the action shape uniform regardless of which
  // form is used.
  return cmd
    .option("-f, --files <paths...>", "explicit file paths")
    .option("--changed", "diff vs merge-base with the default branch")
    .option("--staged", "staged files only (git diff --cached)")
    .option("-a, --all", "every tracked file")
    .option("--skip <names>", "comma-separated step names to skip", commaSplit)
    .option("--only <names>", "comma-separated step names to run", commaSplit)
    .option("-j, --jobs <n>", "parallelism cap", (v) => parseInt(v, 10))
    .option(
      "--force-gates",
      "bypass change-gates and run every step regardless",
    )
    .option(
      "--allow-outside-repo",
      "permit --files paths outside the repo root (footgun — leave off unless you know you need it)",
    )
    .option(
      "--no-prompts",
      "suppress per-step agent-hooks:next-step prompt blocks",
    )
    .option(
      "--agent",
      "force prompt context to `agent` (always emit next-step blocks)",
    )
    .action(async function (this: Command, ...actionArgs: unknown[]) {
      const flags: RunCliFlags = this.opts();
      const positional =
        typeof actionArgs[0] === "string" ? actionArgs[0] : undefined;
      const deps = effectiveDeps(opts.overrides);
      const args: RunArgs = {
        target: targetFrom(positional),
        ...(flags.files ? { explicitFiles: flags.files } : {}),
        ...(flags.changed ? { changed: true } : {}),
        ...(flags.staged ? { staged: true } : {}),
        ...(flags.all ? { all: true } : {}),
        ...(flags.skip ? { skip: flags.skip } : {}),
        ...(flags.only ? { only: flags.only } : {}),
        ...(flags.jobs !== undefined ? { jobs: flags.jobs } : {}),
        ...(flags.forceGates ? { forceGates: true } : {}),
        ...(flags.allowOutsideRepo ? { allowOutsideRepo: true } : {}),
        // commander inverts --no-prompts into prompts: false, so we
        // only set noPrompts when the user explicitly asked.
        ...(flags.prompts === false ? { noPrompts: true } : {}),
        ...(flags.agent ? { promptContext: "agent" } : {}),
      };
      const code = await runCommand(args, deps);
      if (code !== 0) throw new ExitError(code);
    });
}

interface RunCliFlags {
  readonly files?: readonly string[];
  readonly changed?: boolean;
  readonly staged?: boolean;
  readonly all?: boolean;
  readonly skip?: readonly string[];
  readonly only?: readonly string[];
  readonly jobs?: number;
  readonly forceGates?: boolean;
  readonly allowOutsideRepo?: boolean;
  /** Commander inverts `--no-prompts` → `prompts: false`. */
  readonly prompts?: boolean;
  readonly agent?: boolean;
}

export function registerRunCommand(
  program: Command,
  overrides: Partial<RunCommandDeps> = {},
): Command {
  return addRunnerOptions(
    program
      .command("run")
      .description("Run a pipeline or step")
      .argument("<target>", "pipeline or step name"),
    (positional) => positional ?? "",
    { overrides },
  );
}

export function registerCiCommand(
  program: Command,
  overrides: Partial<RunCommandDeps> = {},
): Command {
  return addRunnerOptions(
    program.command("ci").description("Run the `ci` pipeline"),
    () => "ci",
    { overrides },
  );
}

export function registerShortcutCommand(
  program: Command,
  name: string,
  description: string,
  overrides: Partial<RunCommandDeps> = {},
): Command {
  return addRunnerOptions(
    program.command(name).description(description),
    () => name,
    { overrides },
  );
}
