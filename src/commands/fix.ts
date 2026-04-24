/**
 * `agent-hooks fix <step>` — run the step's `fix:` command if defined.
 * Per PLAN §4 line 257 + the sample config on line 163:
 *
 *     lint:
 *       run: eslint {files}
 *       fix: eslint --fix {files}   # used by `agent-hooks fix lint`
 *
 * Implementation: load the config, look up the step, require a `fix`
 * template to be set, then construct a transient config where the
 * step's `run` *is* its `fix`, and reuse the normal pipeline runner.
 * That way chunking, template substitution, parallel workers, env
 * layering, and reporter emission all come for free without a second
 * execution path to keep in sync.
 */

import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import {
  loadProjectConfig,
  resolveWorkspaceSelector,
  type LoadedProject,
  type LoadedWorkspaceConfig,
} from "../config/project.ts";
import type { Config, Step } from "../config/schema.ts";
import { pickReporter } from "../reporters/index.ts";
import {
  defaultEnvResolver,
  resolveEnvironment,
  type EnvResolver,
} from "../runners/env-resolution.ts";
import {
  createGitRunner,
  defaultSpawner,
  PathOutsideRepoError,
  resolveFiles,
  type GitRunner,
  type Scope,
} from "../runners/files.ts";
import { runPipeline } from "../runners/pipeline.ts";
import { routeRepoFiles } from "../runners/workspace-paths.ts";
import type { ExecFn } from "../runners/step.ts";
import { defaultRunDeps } from "./run.ts";
import { isAbsolute, relative, resolve } from "node:path";

export interface FixCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly loadProject?: (cwd: string) => Promise<LoadedProject>;
  readonly makeGit: (cwd: string) => GitRunner;
  readonly exec: ExecFn;
  readonly env: Record<string, string>;
  readonly envResolver?: EnvResolver | null;
}

export interface FixArgs {
  readonly step: string;
  readonly workspace?: string;
  readonly explicitFiles?: readonly string[];
  readonly changed?: boolean;
  readonly staged?: boolean;
  readonly all?: boolean;
}

function pickScope(args: FixArgs): Scope {
  if (args.explicitFiles && args.explicitFiles.length > 0) return "explicit";
  if (args.all) return "all";
  if (args.staged) return "staged";
  if (args.changed) return "changed";
  return "changed";
}

function parseWorkspaceQualifiedStep(step: string): {
  readonly workspace: string | null;
  readonly step: string;
} {
  const colon = step.indexOf(":");
  if (colon <= 0 || colon === step.length - 1) {
    return { workspace: null, step };
  }
  return {
    workspace: step.slice(0, colon),
    step: step.slice(colon + 1),
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
  };
}

/**
 * Build a transient config whose `<step>` has its `run` replaced with
 * its `fix`, plus a one-step pipeline wrapping it. Returns `null` when
 * the step either doesn't exist or has no `fix` defined.
 */
export function buildFixConfig(
  config: Config,
  stepName: string,
): { config: Config; pipelineName: string } | null {
  const step = config.steps[stepName];
  if (!step) return null;
  if (!step.fix) return null;
  const rewritten: Step = {
    ...step,
    run: step.fix,
  };
  return {
    config: {
      ...config,
      steps: {
        ...config.steps,
        [stepName]: rewritten,
      },
      pipelines: {
        ...config.pipelines,
        __agent_hooks_fix__: {
          steps: [stepName],
          parallel: false,
          "exclude-tags": [],
          "include-tags": [],
          "continue-on-error": false,
        },
      },
    },
    pipelineName: "__agent_hooks_fix__",
  };
}

export async function runFixCommand(
  args: FixArgs,
  deps: FixCommandDeps,
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

  const parsed = parseWorkspaceQualifiedStep(args.step);

  async function runOne(
    loaded: LoadedConfig,
    cwd: string,
    repoRoot: string,
    git: GitRunner,
    files: readonly string[],
    stepName: string,
  ): Promise<number> {
    const step = loaded.config.steps[stepName];
    if (!step) return 0;
    if (!step.fix) {
      deps.writeErr(
        `✗ step "${stepName}" has no fix: command defined.\n` +
          `  Add one like: steps.${stepName}.fix: '<your auto-fix command>'\n`,
      );
      return 2;
    }
    const built = buildFixConfig(loaded.config, stepName);
    if (!built) return 2;
    let pipelineEnv = deps.env;
    if (deps.envResolver !== null) {
      const resolver = deps.envResolver ?? defaultEnvResolver;
      const resolved = await resolveEnvironment(
        {
          cwd,
          baseEnv: deps.env,
          ...(loaded.config.env ? { configEnv: loaded.config.env } : {}),
        },
        resolver,
      );
      pipelineEnv = resolved.env;
    }
    const reporter = pickReporter({ env: deps.env, write: deps.write });
    reporter.pipelineStart(built.pipelineName);
    const result = await runPipeline(
      {
        pipelineName: built.pipelineName,
        config: built.config,
        files,
        cwd,
        repoRoot,
        env: pipelineEnv,
        git,
        onStepStart: (info) => reporter.stepStart(info),
        onStepEnd: (outcome) => reporter.stepEnd(outcome),
      },
      deps.exec,
    );
    reporter.pipelineEnd(result);
    return result.exitCode;
  }

  if (project.mode === "single") {
    const loaded = project.loaded;
    const step = loaded.config.steps[parsed.step];
    if (!step) {
      deps.writeErr(
        `✗ unknown step: "${parsed.step}"\n` +
          `  known steps: ${Object.keys(loaded.config.steps).join(", ") || "(none)"}\n`,
      );
      return 2;
    }
    const git = deps.makeGit(deps.cwd);
    try {
      const files = await resolveFiles(git, {
        scope: pickScope(args),
        ...(args.explicitFiles ? { files: args.explicitFiles } : {}),
        repoRoot: deps.cwd,
      });
      return runOne(loaded, deps.cwd, deps.cwd, git, files.files, parsed.step);
    } catch (err) {
      if (err instanceof PathOutsideRepoError) {
        deps.writeErr(`✗ ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  const cliSelector = args.workspace ?? null;
  if (cliSelector && parsed.workspace && cliSelector !== parsed.workspace) {
    deps.writeErr(
      `✗ workspace selector mismatch: --workspace=${cliSelector} but target uses ${parsed.workspace}:${parsed.step}\n`,
    );
    return 2;
  }
  const selector = cliSelector ?? parsed.workspace;
  const git = deps.makeGit(project.repoRoot);
  const explicitFiles = normalizeExplicitFiles(
    args.explicitFiles,
    deps.cwd,
    project.repoRoot,
  );
  let files;
  try {
    files = await resolveFiles(git, {
      scope: pickScope(args),
      ...(explicitFiles ? { files: explicitFiles } : {}),
      repoRoot: project.repoRoot,
    });
  } catch (err) {
    if (err instanceof PathOutsideRepoError) {
      deps.writeErr(`✗ ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const routed = routeRepoFiles(files.files, project.workspaces);

  if (selector) {
    const resolution = resolveWorkspaceSelector(project.workspaces, selector);
    if (resolution.status === "missing") {
      deps.writeErr(`✗ unknown workspace selector: "${selector}"\n`);
      return 2;
    }
    if (resolution.status === "ambiguous") {
      deps.writeErr(
        `✗ workspace selector "${selector}" is ambiguous: ${resolution.matches
          .map((workspace) => workspace.relativePath)
          .join(", ")}\n`,
      );
      return 2;
    }
    const step = resolution.workspace.config.steps[parsed.step];
    if (!step) {
      deps.writeErr(
        `✗ unknown step: "${parsed.step}"\n` +
          `  known steps: ${
            Object.keys(resolution.workspace.config.steps).join(", ") || "(none)"
          }\n`,
      );
      return 2;
    }
    const routedWorkspace = routed.workspaces.find(
      (entry) => entry.workspace.relativePath === resolution.workspace.relativePath,
    );
    return runOne(
      resolution.workspace,
      resolution.workspace.workspaceRoot,
      project.repoRoot,
      rebaseGitRunner(git, resolution.workspace),
      routedWorkspace?.workspaceFiles ?? [],
      parsed.step,
    );
  }

  let sawAny = false;
  let finalCode = 0;

  if (project.root.config.steps[parsed.step]?.fix) {
    sawAny = true;
    finalCode =
      (await runOne(
        project.root,
        project.repoRoot,
        project.repoRoot,
        git,
        routed.rootFiles,
        parsed.step,
      )) ||
      finalCode;
  }

  for (const workspace of routed.workspaces.map((entry) => entry.workspace)) {
    if (!workspace.config.steps[parsed.step]?.fix) continue;
    sawAny = true;
    const routedWorkspace = routed.workspaces.find(
      (entry) => entry.workspace.relativePath === workspace.relativePath,
    );
    const code = await runOne(
      workspace,
      workspace.workspaceRoot,
      project.repoRoot,
      rebaseGitRunner(git, workspace),
      routedWorkspace?.workspaceFiles ?? [],
      parsed.step,
    );
    if (finalCode === 0) finalCode = code;
  }

  if (!sawAny) {
    deps.writeErr(
      `✗ unknown step: "${parsed.step}"\n` +
        `  known steps: ${Object.keys(project.root.config.steps).join(", ") || "(none)"}\n`,
    );
    return 2;
  }
  return finalCode;
}

function commaSplit(value: string): string[] {
  return value
    .split(",")
    .map((stepName) => stepName.trim())
    .filter((stepName) => stepName.length > 0);
}

export function registerFixCommand(
  program: Command,
  overrides: Partial<FixCommandDeps> = {},
): Command {
  return program
    .command("fix")
    .description("Run a step's `fix:` command — e.g. `agent-hooks fix lint`")
    .argument("<step>", "step name with a `fix:` defined in config")
    .option(
      "--workspace <selector>",
      "workspace basename or relative path to target",
    )
    .option("-f, --files <paths...>", "explicit file paths", commaSplit)
    .option("--changed", "diff vs merge-base with the default branch")
    .option("--staged", "staged files only (git diff --cached)")
    .option("-a, --all", "every tracked file")
    .action(async function (this: Command, step: string) {
      const flags: {
        workspace?: string;
        files?: string[];
        changed?: boolean;
        staged?: boolean;
        all?: boolean;
      } = this.opts();
      const deps: FixCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultRunDeps.write,
        writeErr: overrides.writeErr ?? defaultRunDeps.writeErr,
        load: overrides.load ?? ((cwd) => loadConfig({ cwd })),
        makeGit:
          overrides.makeGit ??
          ((cwd) => createGitRunner(cwd, defaultSpawner)),
        exec: overrides.exec ?? defaultRunDeps.exec,
        env: overrides.env ?? defaultRunDeps.env,
        ...(
          overrides.loadProject !== undefined
            ? { loadProject: overrides.loadProject }
            : overrides.load === undefined
              ? { loadProject: (cwd: string) => loadProjectConfig({ cwd }) }
              : {}
        ),
        ...(overrides.envResolver !== undefined
          ? { envResolver: overrides.envResolver }
          : {}),
      };
      const args: FixArgs = {
        step,
        ...(flags.workspace ? { workspace: flags.workspace } : {}),
        ...(flags.files ? { explicitFiles: flags.files } : {}),
        ...(flags.changed ? { changed: true } : {}),
        ...(flags.staged ? { staged: true } : {}),
        ...(flags.all ? { all: true } : {}),
      };
      const code = await runFixCommand(args, deps);
      if (code !== 0) throw new ExitError(code);
    });
}
