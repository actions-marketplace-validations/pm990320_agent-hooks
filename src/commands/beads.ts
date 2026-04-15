import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import { detectBeads, type BeadsFs } from "../integrations/beads/detect.ts";
import { runBeadsPostSync } from "../integrations/beads/post-sync.ts";
import type { ExecFn } from "../runners/step.ts";
import { defaultInitFs } from "./init.ts";
import { defaultRunDeps } from "./run.ts";

export interface BeadsCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly exec: ExecFn;
  readonly fs: BeadsFs;
}

export async function runBeadsPostSyncCommand(
  deps: BeadsCommandDeps,
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

  const detection = await detectBeads(
    deps.cwd,
    loaded.config.beads?.enabled,
    deps.fs,
  );
  if (!detection.enabled) {
    deps.write(`beads not detected — nothing to sync\n`);
    return 0;
  }

  const result = await runBeadsPostSync({
    cwd: deps.cwd,
    exec: deps.exec,
    commitMessage:
      loaded.config.beads?.["commit-message"] ?? "chore(beads): sync",
    agentMarker: loaded.config.beads?.["agent-marker"] ?? "",
  });

  switch (result.status) {
    case "committed":
      deps.write(`✓ beads sync committed\n`);
      return 0;
    case "no-changes":
      deps.write(`  beads sync produced no changes\n`);
      return 0;
    case "sync-failed":
      deps.writeErr(`✗ bd sync failed (exit ${String(result.exitCode)})\n`);
      return result.exitCode;
    case "commit-failed":
      deps.writeErr(
        `✗ beads follow-up commit failed (exit ${String(result.exitCode)})\n`,
      );
      return result.exitCode;
  }
}

// `fs` is a getter to dodge the cli.ts ↔ init.ts ↔ beads.ts module
// cycle — see the matching note in agent.ts. Eager access to
// defaultInitFs hits TDZ when beads.ts is evaluated mid-init of init.ts.
export const defaultBeadsDeps: Omit<BeadsCommandDeps, "cwd"> = {
  write: defaultRunDeps.write,
  writeErr: defaultRunDeps.writeErr,
  load: defaultRunDeps.load,
  exec: defaultRunDeps.exec,
  get fs(): BeadsFs {
    return defaultInitFs;
  },
};

export function registerBeadsCommand(
  program: Command,
  overrides: Partial<BeadsCommandDeps> = {},
): Command {
  const beads = program
    .command("beads")
    .description("Beads integration helpers");

  beads
    .command("post-sync")
    .description(
      "Run `bd sync` and create a follow-up commit if changes were produced",
    )
    .action(async () => {
      const deps: BeadsCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultBeadsDeps.write,
        writeErr: overrides.writeErr ?? defaultBeadsDeps.writeErr,
        load: overrides.load ?? defaultBeadsDeps.load,
        exec: overrides.exec ?? defaultBeadsDeps.exec,
        fs: overrides.fs ?? defaultBeadsDeps.fs,
      };
      const code = await runBeadsPostSyncCommand(deps);
      if (code !== 0) throw new ExitError(code);
    });

  return beads;
}
