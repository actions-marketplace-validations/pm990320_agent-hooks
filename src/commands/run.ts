import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import {
  loadProjectConfig,
  resolveWorkspaceSelector,
  type LoadedProject,
  type LoadedMonorepoProject,
  type LoadedWorkspaceConfig,
} from "../config/project.ts";
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
import { routeRepoFiles } from "../runners/workspace-paths.ts";
import { resolveSkipDirectives } from "../runners/skip-directives.ts";
import { spawnProcess, streamToText } from "../runners/spawn.ts";
import type { ExecFn } from "../runners/step.ts";
import type { StepOutcome } from "../runners/pipeline.ts";
import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

// --- Public shape --------------------------------------------------------

export interface RunCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly loadProject?: (cwd: string) => Promise<LoadedProject>;
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
  readonly workspace?: string;
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

function parseWorkspaceQualifiedTarget(target: string): {
  readonly workspace: string | null;
  readonly target: string;
} {
  const colon = target.indexOf(":");
  if (colon <= 0 || colon === target.length - 1) {
    return { workspace: null, target };
  }
  return {
    workspace: target.slice(0, colon),
    target: target.slice(colon + 1),
  };
}

function normalizeExplicitFiles(
  files: readonly string[] | undefined,
  cwd: string,
  repoRoot: string,
): readonly string[] | undefined {
  if (!files || files.length === 0) return files;
  const root = resolve(repoRoot);
  const from = resolve(cwd);
  return files.map((file) => {
    if (isAbsolute(file)) return file;
    const absolute = resolve(from, file);
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return file;
    }
    return rel.replaceAll("\\", "/");
  });
}

function rebaseGitRunner(
  git: GitRunner,
  workspace: Pick<LoadedWorkspaceConfig, "relativePath" | "workspaceRoot">,
): GitRunner {
  function rebase(files: readonly string[]): readonly string[] {
    return files
      .filter(
        (file) =>
          file === workspace.relativePath ||
          file.startsWith(`${workspace.relativePath}/`),
      )
      .map((file) =>
        file === workspace.relativePath
          ? "."
          : file.slice(workspace.relativePath.length + 1),
      );
  }

  return {
    staged: async () => rebase(await git.staged()),
    changed: async (baseRef?: string) => rebase(await git.changed(baseRef)),
    all: async () => rebase(await git.all()),
    gitRoot: () => Promise.resolve(workspace.workspaceRoot),
    ...(git.commitMessage
      ? {
          commitMessage: () => {
            if (!git.commitMessage) return Promise.resolve(null);
            return git.commitMessage();
          },
        }
      : {}),
    ...(git.modifiedUnder
      ? {
          modifiedUnder: async (subPath: string) => {
            const target =
              subPath === "." || subPath.length === 0
                ? workspace.relativePath
                : `${workspace.relativePath}/${subPath}`.replaceAll("//", "/");
            if (!git.modifiedUnder) return [];
            return rebase(await git.modifiedUnder(target));
          },
        }
      : {}),
    ...(git.stage
      ? {
          stage: async (paths: readonly string[]) => {
            const repoPaths = paths.map((file) =>
              file === "." || file.length === 0
                ? workspace.relativePath
                : `${workspace.relativePath}/${file}`.replaceAll("//", "/"),
            );
            if (!git.stage) return;
            await git.stage(repoPaths);
          },
        }
      : {}),
  };
}

// --- Core action ---------------------------------------------------------

interface PreparedRun {
  readonly repoRoot: string;
  readonly git: GitRunner;
  readonly scope: Scope;
  readonly files: readonly string[];
  readonly directives: ReturnType<typeof resolveSkipDirectives>;
  readonly promptContext: PromptContext;
}

interface ExecuteTargetOptions {
  readonly target: string;
  readonly cwd: string;
  readonly loaded: LoadedConfig;
  readonly git: GitRunner;
  readonly files: readonly string[];
  readonly prepared: PreparedRun;
}

async function prepareRun(
  args: RunArgs,
  deps: RunCommandDeps,
  repoRoot: string,
  git: GitRunner,
): Promise<PreparedRun> {
  const scope = pickScope(args);
  const explicitFiles = normalizeExplicitFiles(args.explicitFiles, deps.cwd, repoRoot);
  const resolvedFiles = await resolveFiles(git, {
    scope,
    ...(explicitFiles ? { files: explicitFiles } : {}),
    repoRoot,
    ...(args.allowOutsideRepo ? { allowOutsideRepo: true } : {}),
  });

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

  return {
    repoRoot,
    git,
    scope,
    files: resolvedFiles.files,
    directives,
    promptContext: args.promptContext ?? detectPromptContext(deps.env),
  };
}

async function executeResolvedTarget(
  args: RunArgs,
  deps: RunCommandDeps,
  options: ExecuteTargetOptions,
): Promise<number> {
  const { target, cwd, loaded, git, files, prepared } = options;
  const resolved = resolveTarget(loaded.config, target);
  if (!resolved) return 0;

  const reporter =
    deps.reporter ?? pickReporter({ env: deps.env, write: deps.write });

  let effectiveSkip = prepared.directives.skip;
  if (prepared.directives.skipAll) {
    effectiveSkip = new Set(Object.keys(resolved.config.steps));
    deps.write(
      `  ⊘ skipping all steps (skipAll directive from ${
        prepared.directives.sources[prepared.directives.sources.length - 1]?.from
          .kind ?? "config"
      })\n`,
    );
  }

  let pipelineEnv = deps.env;
  if (deps.envResolver !== null) {
    const resolverImpl = deps.envResolver ?? defaultEnvResolver;
    const resolvedEnv = await resolveEnvironment(
      {
        cwd,
        baseEnv: deps.env,
        ...(loaded.config.env ? { configEnv: loaded.config.env } : {}),
      },
      resolverImpl,
    );
    pipelineEnv = resolvedEnv.env;
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

  const promptPolicy = pickPromptPolicy(
    prepared.promptContext,
    args.noPrompts ?? false,
  );
  const artifactBaseline = new Map<string, ArtifactSnapshot>();
  const playwrightCheckpoint = await detectPlaywrightCheckpoint(cwd);
  const ciReportLines: string[] = [];
  const buildArtifactsReport = (
    stepName: string,
    before: ArtifactSnapshot,
    after: ArtifactSnapshot,
  ): string[] =>
    diffArtifacts(before, after)
      .filter((path) => {
        const step = resolved.config.steps[stepName];
        const candidates = effectiveArtifactInputs(step?.artifacts);
        return candidates.some((candidate) => path.startsWith(candidate));
      })
      .sort();

  function yamlEscape(value: string): string {
    if (value.length === 0) return '""';
    if (/[\n:#"]/.test(value) || /^\s/.test(value) || /\s$/.test(value)) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  function writeCiReport(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const reportPath = resolve(cwd, "agent-hooks-report.yml");
    const body = ["steps:"].concat(lines).join("\n").concat("\n");
    writeFileSync(reportPath, body, "utf8");
  }

  function buildCiReportEntry(
    outcome: StepOutcome,
    artifacts: readonly string[],
  ): string[] {
    const emittedFiles = (outcome.result?.files ?? []).join(" ");
    const lines: string[] = [];
    lines.push(`- step: ${yamlEscape(outcome.name)}`);
    lines.push("  status: failed");
    lines.push(`  exit_code: ${String(outcome.result?.exitCode ?? 0)}`);
    lines.push(`  duration: ${String(stepDurationSeconds(outcome) ?? 0)}s`);
    lines.push(`  summary: ${yamlEscape(outcome.result?.reason ?? "failed")}`);
    if (emittedFiles.length > 0) {
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
      files,
      cwd,
      env: pipelineEnv,
      git,
      ...(effectiveSkip.size > 0 ? { skip: effectiveSkip } : {}),
      ...(prepared.directives.only.size > 0
        ? { only: prepared.directives.only }
        : {}),
      ...(args.jobs !== undefined ? { jobs: args.jobs } : {}),
      ...(args.forceGates ? { forceGates: true } : {}),
      onStepStart: (info) => {
        reporter.stepStart(info);
        const step = resolved.config.steps[info.name];
        if (!step) return;
        const candidates = effectiveArtifactInputs(step.artifacts);
        const before = snapshotArtifacts(cwd, candidates);
        artifactBaseline.set(info.name, before);
      },
      onStepEnd: (outcome) => {
        reporter.stepEnd(outcome);
        const step = resolved.config.steps[outcome.name];
        if (step) {
          const candidates = effectiveArtifactInputs(step.artifacts);
          const before = artifactBaseline.get(outcome.name) ?? new Map();
          const after = snapshotArtifacts(cwd, candidates);
          const artifacts = buildArtifactsReport(outcome.name, before, after);
          if (shouldEmitPrompt(outcome, promptPolicy)) {
            deps.writeErr(
              renderNextStepBlock({
                outcome,
                step,
                cwd,
                files: outcome.result?.files ?? [],
                playwrightCheckpoint,
                artifacts,
              }),
            );
          }
          if (
            prepared.promptContext === "ci" &&
            outcome.result?.status === "failed"
          ) {
            ciReportLines.push(...buildCiReportEntry(outcome, artifacts));
          }
        }
      },
    },
    deps.exec,
  );
  if (prepared.promptContext === "ci" && ciReportLines.length > 0) {
    writeCiReport(ciReportLines);
  }
  reporter.pipelineEnd(result);
  return result.exitCode;
}

function formatUnknownTargetError(
  loaded: LoadedConfig,
  target: string,
): string {
  return (
    `✗ unknown pipeline or step: "${target}"\n` +
    `  known pipelines: ${Object.keys(loaded.config.pipelines).join(", ") || "(none)"}\n` +
    `  known steps:     ${Object.keys(loaded.config.steps).join(", ") || "(none)"}\n`
  );
}

function selectWorkspacesForRun(
  project: LoadedMonorepoProject,
  args: RunArgs,
  target: string,
  repoFiles: ReturnType<typeof routeRepoFiles>,
  explicitSelector: string | null,
): {
  readonly workspaces: readonly LoadedWorkspaceConfig[];
  readonly includeRoot: boolean;
  readonly error?: string;
} {
  const cliSelector = args.workspace ?? null;
  if (cliSelector && explicitSelector && cliSelector !== explicitSelector) {
    return {
      workspaces: [],
      includeRoot: false,
      error:
        `✗ workspace selector mismatch: --workspace=${cliSelector} but target uses ${explicitSelector}:${target}\n`,
    };
  }
  const selector = cliSelector ?? explicitSelector;
  if (selector) {
    const resolution = resolveWorkspaceSelector(project.workspaces, selector);
    if (resolution.status === "missing") {
      return {
        workspaces: [],
        includeRoot: false,
        error: `✗ unknown workspace selector: "${selector}"\n`,
      };
    }
    if (resolution.status === "ambiguous") {
      const matches = resolution.matches
        .map((workspace) => workspace.relativePath)
        .join(", ");
      return {
        workspaces: [],
        includeRoot: false,
        error: `✗ workspace selector "${selector}" is ambiguous: ${matches}\n`,
      };
    }
    return {
      workspaces: [resolution.workspace],
      includeRoot: false,
    };
  }

  if (target === "ci") {
    return { workspaces: project.workspaces, includeRoot: true };
  }

  const mode =
    project.root.config.monorepo?.["run-workspace-selection-default"] ??
    "affected";
  if (mode === "all") {
    return { workspaces: project.workspaces, includeRoot: true };
  }
  const selected = repoFiles.workspaces.map((entry) => entry.workspace);
  return { workspaces: selected, includeRoot: true };
}

export async function runCommand(
  args: RunArgs,
  deps: RunCommandDeps,
): Promise<number> {
  let project: LoadedProject;
  try {
    if (deps.loadProject) {
      project = await deps.loadProject(deps.cwd);
    } else {
      project = { mode: "single", loaded: await deps.load(deps.cwd) };
    }
  } catch (err) {
    if (err instanceof ConfigNotFoundError || err instanceof ConfigError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }

  const parsedTarget = parseWorkspaceQualifiedTarget(args.target);

  if (project.mode === "single") {
    const loaded = project.loaded;
    const resolved = resolveTarget(loaded.config, parsedTarget.target);
    if (!resolved) {
      deps.writeErr(formatUnknownTargetError(loaded, parsedTarget.target));
      return 2;
    }
    const initialGit = deps.makeGit(deps.cwd);
    const repoRoot =
      (initialGit.gitRoot && (await initialGit.gitRoot())) ?? deps.cwd;
    const effectiveCwd = repoRoot;
    const git =
      effectiveCwd === deps.cwd ? initialGit : deps.makeGit(effectiveCwd);
    let prepared: PreparedRun;
    try {
      prepared = await prepareRun(args, deps, effectiveCwd, git);
    } catch (err) {
      if (err instanceof PathOutsideRepoError) {
        deps.writeErr(`✗ ${err.message}\n`);
        return 2;
      }
      throw err;
    }
    return executeResolvedTarget(args, deps, {
      target: parsedTarget.target,
      cwd: effectiveCwd,
      loaded,
      git,
      files: prepared.files,
      prepared,
    });
  }

  for (const warning of project.warnings) {
    deps.write(`  ⚠ ${warning}\n`);
  }

  const git = deps.makeGit(project.repoRoot);
  let prepared: PreparedRun;
  try {
    prepared = await prepareRun(args, deps, project.repoRoot, git);
  } catch (err) {
    if (err instanceof PathOutsideRepoError) {
      deps.writeErr(`✗ ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const routed = routeRepoFiles(prepared.files, project.workspaces);
  const selection = selectWorkspacesForRun(
    project,
    args,
    parsedTarget.target,
    routed,
    parsedTarget.workspace,
  );
  if (selection.error) {
    deps.writeErr(selection.error);
    return 2;
  }

  const workspaceFileMap = new Map(
    routed.workspaces.map((entry) => [entry.workspace.relativePath, entry.workspaceFiles]),
  );

  const runs: Promise<number>[] = [];
  let sawAny = false;

  if (selection.includeRoot && resolveTarget(project.root.config, parsedTarget.target)) {
    sawAny = true;
    runs.push(
      executeResolvedTarget(args, deps, {
        target: parsedTarget.target,
        cwd: project.repoRoot,
        loaded: project.root,
        git,
        files: routed.rootFiles,
        prepared,
      }),
    );
  }

  for (const workspace of selection.workspaces) {
    if (!resolveTarget(workspace.config, parsedTarget.target)) continue;
    sawAny = true;
    runs.push(
      executeResolvedTarget(args, deps, {
        target: parsedTarget.target,
        cwd: workspace.workspaceRoot,
        loaded: workspace,
        git: rebaseGitRunner(git, workspace),
        files: workspaceFileMap.get(workspace.relativePath) ?? [],
        prepared,
      }),
    );
  }

  if (!sawAny) {
    deps.writeErr(formatUnknownTargetError(project.root, parsedTarget.target));
    return 2;
  }

  const codes = await Promise.all(runs);
  return codes.find((code) => code !== 0) ?? 0;
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
  loadProject(cwd) {
    return loadProjectConfig({ cwd });
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
      const proc = spawnProcess({
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
          proc.stdin.end(stdin);
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
    const proc = spawnProcess({
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
        proc.stdin.end(stdin);
      }
      // Start the stream drains eagerly so any output already buffered
      // is captured, but don't let them block the return on a timeout:
      // `sh -c 'foo'` forks a grandchild that inherits the pipe write
      // ends, so killing sh doesn't close the read ends. On Linux that
      // leaves the reads waiting indefinitely until the grandchild
      // naturally exits. When runWithTimeout reports timedOut, give
      // the reads a short grace window to flush what they already have
      // and then give up on the rest.
      const stdoutPromise = streamToText(proc.stdout);
      const stderrPromise = streamToText(proc.stderr);
      const { exitCode, timedOut } = await runWithTimeout(proc);
      const graceMs = 500;
      const raceGrace = (p: Promise<string>): Promise<string> =>
        Promise.race([
          p,
          new Promise<string>((resolve) => {
            const t = setTimeout(() => resolve(""), graceMs);
            (t as unknown as { unref?: () => void }).unref?.();
          }),
        ]);
      const [stdoutText, stderrText] = timedOut
        ? await Promise.all([raceGrace(stdoutPromise), raceGrace(stderrPromise)])
        : await Promise.all([stdoutPromise, stderrPromise]);
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
    ...(
      overrides?.loadProject !== undefined
        ? { loadProject: overrides.loadProject }
        : overrides?.load === undefined && defaultRunDeps.loadProject
          ? { loadProject: defaultRunDeps.loadProject }
          : {}
    ),
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
    .option(
      "--workspace <selector>",
      "workspace basename or relative path to target",
    )
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
        ...(flags.workspace ? { workspace: flags.workspace } : {}),
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
  readonly workspace?: string;
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
