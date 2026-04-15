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
  resolveFiles,
  type GitRunner,
  type Scope,
} from "../runners/files.ts";
import { runPipeline } from "../runners/pipeline.ts";
import type { ExecFn } from "../runners/step.ts";
import { defaultRunDeps } from "./run.ts";

export interface FixCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly makeGit: (cwd: string) => GitRunner;
  readonly exec: ExecFn;
  readonly env: Record<string, string>;
  readonly envResolver?: EnvResolver | null;
}

export interface FixArgs {
  readonly step: string;
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

  const step = loaded.config.steps[args.step];
  if (!step) {
    deps.writeErr(
      `✗ unknown step: "${args.step}"\n` +
        `  known steps: ${Object.keys(loaded.config.steps).join(", ") || "(none)"}\n`,
    );
    return 2;
  }
  if (!step.fix) {
    deps.writeErr(
      `✗ step "${args.step}" has no fix: command defined.\n` +
        `  Add one like: steps.${args.step}.fix: '<your auto-fix command>'\n`,
    );
    return 2;
  }

  const built = buildFixConfig(loaded.config, args.step);
  if (!built) {
    // unreachable — we just verified step + fix exist.
    return 2;
  }

  const git = deps.makeGit(deps.cwd);
  const scope = pickScope(args);
  const files = await resolveFiles(git, {
    scope,
    ...(args.explicitFiles ? { files: args.explicitFiles } : {}),
    repoRoot: deps.cwd,
  });

  // Auto env resolution, same as run.ts. `null` disables it for tests.
  let pipelineEnv = deps.env;
  if (deps.envResolver !== null) {
    const resolver = deps.envResolver ?? defaultEnvResolver;
    const resolved = await resolveEnvironment(
      { cwd: deps.cwd, baseEnv: deps.env },
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
      files: files.files,
      cwd: deps.cwd,
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

function commaSplit(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function registerFixCommand(
  program: Command,
  overrides: Partial<FixCommandDeps> = {},
): Command {
  return program
    .command("fix")
    .description("Run a step's `fix:` command — e.g. `agent-hooks fix lint`")
    .argument("<step>", "step name with a `fix:` defined in config")
    .option("-f, --files <paths...>", "explicit file paths", commaSplit)
    .option("--changed", "diff vs merge-base with the default branch")
    .option("--staged", "staged files only (git diff --cached)")
    .option("-a, --all", "every tracked file")
    .action(async function (this: Command, step: string) {
      const flags: {
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
        ...(overrides.envResolver !== undefined
          ? { envResolver: overrides.envResolver }
          : {}),
      };
      const args: FixArgs = {
        step,
        ...(flags.files ? { explicitFiles: flags.files } : {}),
        ...(flags.changed ? { changed: true } : {}),
        ...(flags.staged ? { staged: true } : {}),
        ...(flags.all ? { all: true } : {}),
      };
      const code = await runFixCommand(args, deps);
      if (code !== 0) throw new ExitError(code);
    });
}
