import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import type { LoadedProject } from "../config/project.ts";
import {
  defaultHookFs,
  installHooks,
  type HookFs,
  type InstallResult,
} from "../integrations/git/install.ts";
import {
  projectConfigHash,
  projectHookNames,
} from "../integrations/git/hash.ts";
import { defaultRunDeps } from "./run.ts";

export interface InstallCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly loadProject?: (cwd: string) => Promise<LoadedProject>;
  readonly hookFs: HookFs;
}

export interface InstallArgs {
  readonly ifMissing?: boolean;
}

function formatOutcome(result: InstallResult): string {
  const lines: string[] = [];
  for (const outcome of result.outcomes) {
    lines.push(`  ${outcome.status.padEnd(20)} ${outcome.hookName}`);
  }
  lines.push(
    `✓ install complete — ${String(result.outcomes.length)} hooks processed`,
  );
  return `${lines.join("\n")}\n`;
}

export async function runInstallCommand(
  args: InstallArgs,
  deps: InstallCommandDeps,
): Promise<number> {
  let project: LoadedProject;
  try {
    if (deps.loadProject) {
      project = await deps.loadProject(deps.cwd);
    } else {
      project = { mode: "single", loaded: await deps.load(deps.cwd) };
    }
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ConfigNotFoundError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }

  const result =
    project.mode === "single"
      ? await installHooks({
          gitRoot: deps.cwd,
          config: project.loaded.config,
          fs: deps.hookFs,
          ifMissing: args.ifMissing ?? false,
        })
      : await installHooks({
          gitRoot: project.repoRoot,
          config: project.root.config,
          fs: deps.hookFs,
          ifMissing: args.ifMissing ?? false,
          hash: projectConfigHash(project),
          hookNames: projectHookNames(project),
        });

  if (args.ifMissing && result.allUpToDate) {
    // Intentionally silent — postinstall scripts don't need to chatter.
    return 0;
  }

  deps.write(formatOutcome(result));
  return 0;
}

export const defaultInstallDeps = {
  write: defaultRunDeps.write,
  writeErr: defaultRunDeps.writeErr,
  load: defaultRunDeps.load,
  ...(defaultRunDeps.loadProject
    ? { loadProject: defaultRunDeps.loadProject }
    : {}),
  hookFs: defaultHookFs,
} satisfies Omit<InstallCommandDeps, "cwd">;

export function registerInstallCommand(
  program: Command,
  overrides: Partial<InstallCommandDeps> = {},
): Command {
  return program
    .command("install")
    .description("Install git hook stubs based on the current config")
    .option(
      "--if-missing",
      "skip when every hook is already wired with the current config hash",
    )
    .action(async function (this: Command) {
      const flags: { ifMissing?: boolean } = this.opts();
      const deps: InstallCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultInstallDeps.write,
        writeErr: overrides.writeErr ?? defaultInstallDeps.writeErr,
        load: overrides.load ?? defaultInstallDeps.load,
        ...(
          overrides.loadProject !== undefined
            ? { loadProject: overrides.loadProject }
            : overrides.load === undefined && defaultInstallDeps.loadProject
              ? { loadProject: defaultInstallDeps.loadProject }
              : {}
        ),
        hookFs: overrides.hookFs ?? defaultInstallDeps.hookFs,
      };
      const code = await runInstallCommand(
        { ...(flags.ifMissing ? { ifMissing: true } : {}) },
        deps,
      );
      if (code !== 0) throw new ExitError(code);
    });
}
