import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import {
  defaultHookFs,
  installHooks,
  type HookFs,
  type InstallResult,
} from "../integrations/git/install.ts";
import { defaultRunDeps } from "./run.ts";

export interface InstallCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
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
  let loaded: LoadedConfig;
  try {
    loaded = await deps.load(deps.cwd);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ConfigNotFoundError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }

  const result = await installHooks({
    gitRoot: deps.cwd,
    config: loaded.config,
    fs: deps.hookFs,
    ifMissing: args.ifMissing ?? false,
  });

  if (args.ifMissing && result.allUpToDate) {
    // Intentionally silent — postinstall scripts don't need to chatter.
    return 0;
  }

  deps.write(formatOutcome(result));
  return 0;
}

export const defaultInstallDeps: Omit<InstallCommandDeps, "cwd"> = {
  write: defaultRunDeps.write,
  writeErr: defaultRunDeps.writeErr,
  load: defaultRunDeps.load,
  hookFs: defaultHookFs,
};

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
        hookFs: overrides.hookFs ?? defaultInstallDeps.hookFs,
      };
      const code = await runInstallCommand(
        { ...(flags.ifMissing ? { ifMissing: true } : {}) },
        deps,
      );
      if (code !== 0) throw new ExitError(code);
    });
}
