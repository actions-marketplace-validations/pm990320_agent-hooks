import type { Command } from "commander";
import os from "node:os";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import {
  AGENT_HANDLERS,
  getAgentHandler,
} from "../hooks/registry.ts";
import type { AgentFs, AgentInstallScope } from "../hooks/types.ts";
import {
  AGENTS_MD_TARGETS,
  installAgentsMdBlock,
  statusAgentsMdBlock,
  uninstallAgentsMdBlock,
  type AgentsMdFs,
  type AgentsMdOutcome,
  type AgentsMdStatusEntry,
} from "../integrations/agents-md/install.ts";
import {
  defaultSkillFs,
  installSkill,
  resolveSkillPaths,
  uninstallSkill,
  type SkillFs,
  type SkillTarget,
} from "../integrations/skill/install.ts";
import { defaultInitFs, type InitFs } from "./init.ts";
import { defaultRunDeps } from "./run.ts";

export interface AgentCommandDeps {
  readonly cwd: string;
  readonly homeDir: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly fs: InitFs;
  readonly skillFs?: SkillFs;
  readonly loadSkillTemplate?: () => Promise<string>;
  /** Filesystem adapter for CLAUDE.md / AGENTS.md marker-block work. */
  readonly agentsMdFs?: AgentsMdFs;
}

/**
 * Adapt the InitFs shape into the narrower AgentsMdFs shape. Same
 * underlying bytes — the marker-block installer doesn't need
 * mkdirRecursive since it never creates new files.
 */
function asAgentsMdFs(initFs: InitFs): AgentsMdFs {
  return {
    exists: (p) => initFs.exists(p),
    read: (p) => initFs.read(p),
    write: (p, contents) => initFs.write(p, contents),
  };
}

/**
 * The InitFs adapter happens to satisfy AgentFs's shape (plus
 * mkdirRecursive), so we wrap it rather than duplicating adapters.
 */
function asAgentFs(initFs: InitFs): AgentFs {
  return {
    exists: (p) => initFs.exists(p),
    read: (p) => initFs.read(p),
    write: (p, contents) => initFs.write(p, contents),
    mkdirRecursive: (p) => initFs.mkdirRecursive(p),
  };
}

export async function runAgentInstall(
  agentName: string,
  deps: AgentCommandDeps,
  scope: AgentInstallScope = "project",
): Promise<number> {
  if (agentName === "generic") {
    deps.write(
      [
        "# Generic agent integration",
        "# Put this shell snippet wherever your agent fires after an edit:",
        "",
        "  agent-hooks hook generic edit",
        "",
        "# Files should be piped in on stdin (one per line) or passed",
        "# as arguments. The generic dispatcher reads both.",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const handler = getAgentHandler(agentName);
  if (!handler) {
    const known = ["generic", ...AGENT_HANDLERS.map((h) => h.name)].join(
      ", ",
    );
    deps.writeErr(`✗ unknown agent: "${agentName}"\n  known: ${known}\n`);
    return 2;
  }

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

  try {
    const result = await handler.install({
      config: loaded.config,
      cwd: deps.cwd,
      homeDir: deps.homeDir,
      scope,
      fs: asAgentFs(deps.fs),
    });
    const action =
      result.action === "unchanged" ? "no change" : result.action;
    deps.write(`✓ ${handler.displayName}: ${action} → ${result.path}\n`);
    return 0;
  } catch (err) {
    if (err instanceof SyntaxError) {
      deps.writeErr(
        `✗ failed to parse existing settings: ${err.message}\n`,
      );
      return 2;
    }
    throw err;
  }
}

export async function runAgentList(deps: AgentCommandDeps): Promise<number> {
  const agentFs = asAgentFs(deps.fs);
  deps.write("Known agents:\n");
  for (const handler of AGENT_HANDLERS) {
    const detection = await handler.detect(
      deps.cwd,
      deps.homeDir,
      agentFs,
    );
    const marker = detection.present ? "✓" : "⊘";
    const scope = detection.scope ? ` [${detection.scope}]` : "";
    deps.write(
      `  ${marker} ${handler.name.padEnd(16)} ${handler.displayName}${scope}\n`,
    );
  }
  deps.write(
    "\nUse 'agent-hooks agent install <name> [--scope project|user]' to wire one up.\n",
  );
  return 0;
}

export const SKILL_TARGETS = ["claude", "cursor", "codex"] as const;

function isSkillTarget(name: string): name is SkillTarget {
  return (SKILL_TARGETS as readonly string[]).includes(name);
}

export interface SkillArgs {
  readonly target: string;
  readonly project?: boolean;
}

export async function runSkillInstall(
  args: SkillArgs,
  deps: AgentCommandDeps,
): Promise<number> {
  if (!isSkillTarget(args.target)) {
    deps.writeErr(
      `✗ unknown skill target: "${args.target}"\n  known: ${SKILL_TARGETS.join(", ")}\n`,
    );
    return 2;
  }
  const result = await installSkill({
    target: args.target,
    scope: args.project === true ? "project" : "user",
    repoCwd: deps.cwd,
    fs: deps.skillFs ?? defaultSkillFs,
    ...(deps.loadSkillTemplate
      ? { loadTemplate: deps.loadSkillTemplate }
      : {}),
  });
  deps.write(`✓ installed skill: ${result.filePath}\n`);
  return 0;
}

/**
 * `agent skill list` — enumerate installed skill files across every
 * known target × scope combination. Pure probe: just checks each
 * candidate path via the injected SkillFs and prints the installed
 * ones. Per PLAN §4 line 264.
 */
export async function runSkillList(
  deps: AgentCommandDeps,
): Promise<number> {
  const fs = deps.skillFs ?? defaultSkillFs;
  deps.write(`agent-hooks skill locations:\n`);
  let anyInstalled = false;
  for (const target of SKILL_TARGETS) {
    deps.write(`  ${target}:\n`);
    for (const scope of ["user", "project"] as const) {
      const paths = resolveSkillPaths(
        target,
        scope,
        deps.cwd,
      );
      const exists = await fs.exists(paths.filePath);
      const glyph = exists ? "✓" : "·";
      deps.write(`    ${glyph} ${scope.padEnd(7)} ${paths.filePath}\n`);
      if (exists) anyInstalled = true;
    }
  }
  if (!anyInstalled) {
    deps.write(
      `\n  (no skills installed yet — try 'agent-hooks agent skill install claude')\n`,
    );
  }
  return 0;
}

// --- agent instructions install/uninstall/status -----------------------

function agentsMdFsFor(deps: AgentCommandDeps): AgentsMdFs {
  return deps.agentsMdFs ?? asAgentsMdFs(deps.fs);
}

function reportAgentsMdOutcomes(
  deps: AgentCommandDeps,
  outcomes: readonly AgentsMdOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.action === "missing") {
      deps.write(`  ·  ${outcome.path} (not present)\n`);
      continue;
    }
    const label =
      outcome.action === "inserted"
        ? "wrote"
        : outcome.action === "refreshed"
          ? "updated"
          : outcome.action === "removed"
            ? "removed"
            : "ok";
    deps.write(`  ${label.padEnd(8)}${outcome.path}\n`);
  }
}

function reportAgentsMdStatus(
  deps: AgentCommandDeps,
  entries: readonly AgentsMdStatusEntry[],
): void {
  for (const entry of entries) {
    if (!entry.exists) {
      deps.write(`  ·  ${entry.path} (not present)\n`);
      continue;
    }
    if (!entry.blockPresent) {
      deps.write(`  ·  ${entry.path} (no block)\n`);
      continue;
    }
    const glyph = entry.inSync ? "✓" : "⚠";
    const note = entry.inSync ? "in sync" : "stale — run `agent-hooks agent instructions install`";
    deps.write(`  ${glyph}  ${entry.path} (${note})\n`);
  }
}

/**
 * `agent-hooks agent instructions install` — splice the constant
 * agent-hooks marker block into CLAUDE.md / AGENTS.md wherever they
 * already exist. Never creates the files.
 */
export async function runAgentsMdInstall(
  deps: AgentCommandDeps,
): Promise<number> {
  const outcomes = await installAgentsMdBlock({
    cwd: deps.cwd,
    fs: agentsMdFsFor(deps),
  });
  deps.write("agent-hooks instructions:\n");
  reportAgentsMdOutcomes(deps, outcomes);
  const touched = outcomes.some(
    (o) => o.action === "inserted" || o.action === "refreshed",
  );
  if (!touched) {
    const anyPresent = outcomes.some((o) => o.action !== "missing");
    if (!anyPresent) {
      deps.write(
        "\n  (no CLAUDE.md or AGENTS.md found — create one to opt in)\n",
      );
    }
  }
  return 0;
}

/**
 * `agent-hooks agent instructions uninstall` — strip the marker block
 * from CLAUDE.md / AGENTS.md wherever it's present.
 */
export async function runAgentsMdUninstall(
  deps: AgentCommandDeps,
): Promise<number> {
  const outcomes = await uninstallAgentsMdBlock({
    cwd: deps.cwd,
    fs: agentsMdFsFor(deps),
  });
  deps.write("agent-hooks instructions:\n");
  reportAgentsMdOutcomes(deps, outcomes);
  return 0;
}

/**
 * `agent-hooks agent instructions list` — probe each target and
 * report presence + in-sync status for the marker block.
 */
export async function runAgentsMdList(
  deps: AgentCommandDeps,
): Promise<number> {
  const entries = await statusAgentsMdBlock({
    cwd: deps.cwd,
    fs: agentsMdFsFor(deps),
  });
  deps.write("agent-hooks instructions:\n");
  reportAgentsMdStatus(deps, entries);
  return 0;
}

// Re-exported so tests can assert against the canonical target list.
export { AGENTS_MD_TARGETS };

export async function runSkillUninstall(
  args: SkillArgs,
  deps: AgentCommandDeps,
): Promise<number> {
  if (!isSkillTarget(args.target)) {
    deps.writeErr(
      `✗ unknown skill target: "${args.target}"\n  known: ${SKILL_TARGETS.join(", ")}\n`,
    );
    return 2;
  }
  const result = await uninstallSkill({
    target: args.target,
    scope: args.project === true ? "project" : "user",
    repoCwd: deps.cwd,
    fs: deps.skillFs ?? defaultSkillFs,
    ...(deps.loadSkillTemplate
      ? { loadTemplate: deps.loadSkillTemplate }
      : {}),
  });
  if (result.removed) {
    deps.write(`✓ removed skill: ${result.filePath}\n`);
  } else {
    deps.write(`  skill not installed at ${result.filePath}\n`);
  }
  return 0;
}

// Lazy `fs` getter dodges the cli.ts ↔ init.ts ↔ agent.ts module
// cycle. Reading the static `defaultInitFs` binding at module-init
// time crashes when agent.ts is evaluated mid-way through init.ts —
// the const isn't bound yet (TDZ). Resolving on first access defers
// past init.ts's full evaluation.
export const defaultAgentDeps: Omit<AgentCommandDeps, "cwd"> = {
  homeDir: os.homedir(),
  write: defaultRunDeps.write,
  writeErr: defaultRunDeps.writeErr,
  load: defaultRunDeps.load,
  get fs(): InitFs {
    return defaultInitFs;
  },
};

export function registerAgentCommand(
  program: Command,
  overrides: Partial<AgentCommandDeps> = {},
): Command {
  const agent = program
    .command("agent")
    .description("Install and manage coding-agent integrations");

  function buildDeps(): AgentCommandDeps {
    return {
      cwd: overrides.cwd ?? process.cwd(),
      homeDir: overrides.homeDir ?? defaultAgentDeps.homeDir,
      write: overrides.write ?? defaultAgentDeps.write,
      writeErr: overrides.writeErr ?? defaultAgentDeps.writeErr,
      load: overrides.load ?? defaultAgentDeps.load,
      fs: overrides.fs ?? defaultAgentDeps.fs,
      ...(overrides.skillFs ? { skillFs: overrides.skillFs } : {}),
      ...(overrides.loadSkillTemplate
        ? { loadSkillTemplate: overrides.loadSkillTemplate }
        : {}),
      ...(overrides.agentsMdFs ? { agentsMdFs: overrides.agentsMdFs } : {}),
    };
  }

  agent
    .command("install")
    .description("Install an agent's native hook configuration")
    .argument("<name>", "one of: generic, claude, gemini-cli, …")
    .option(
      "--scope <scope>",
      "install scope (project or user)",
      "project",
    )
    .action(async function (this: Command, name: string) {
      const flags: { scope?: string } = this.opts();
      const scope: AgentInstallScope =
        flags.scope === "user" ? "user" : "project";
      const code = await runAgentInstall(name, buildDeps(), scope);
      if (code !== 0) throw new ExitError(code);
    });

  agent
    .command("list")
    .description("List known agents and their detection status")
    .action(async () => {
      const code = await runAgentList(buildDeps());
      if (code !== 0) throw new ExitError(code);
    });

  const skill = agent
    .command("skill")
    .description("Install the agent-hooks skill file for a coding agent");

  skill
    .command("install")
    .description("Install the skill for <target>")
    .argument("<target>", `one of: ${SKILL_TARGETS.join(", ")}`)
    .option("--project", "install into the current repo instead of home")
    .action(async function (this: Command, target: string) {
      const flags: { project?: boolean } = this.opts();
      const code = await runSkillInstall(
        { target, ...(flags.project ? { project: true } : {}) },
        buildDeps(),
      );
      if (code !== 0) throw new ExitError(code);
    });

  skill
    .command("uninstall")
    .description("Remove the installed skill for <target>")
    .argument("<target>", `one of: ${SKILL_TARGETS.join(", ")}`)
    .option("--project", "operate on the repo-local copy instead of home")
    .action(async function (this: Command, target: string) {
      const flags: { project?: boolean } = this.opts();
      const code = await runSkillUninstall(
        { target, ...(flags.project ? { project: true } : {}) },
        buildDeps(),
      );
      if (code !== 0) throw new ExitError(code);
    });

  skill
    .command("list")
    .description("Show installed skill locations across all known targets")
    .action(async () => {
      const code = await runSkillList(buildDeps());
      if (code !== 0) throw new ExitError(code);
    });

  const instructions = agent
    .command("instructions")
    .description(
      "Inject or remove the agent-hooks marker block in CLAUDE.md / AGENTS.md",
    );

  instructions
    .command("install")
    .description(
      "Splice the agent-hooks block into CLAUDE.md / AGENTS.md if they exist",
    )
    .action(async () => {
      const code = await runAgentsMdInstall(buildDeps());
      if (code !== 0) throw new ExitError(code);
    });

  instructions
    .command("uninstall")
    .description(
      "Strip the agent-hooks block from CLAUDE.md / AGENTS.md where present",
    )
    .action(async () => {
      const code = await runAgentsMdUninstall(buildDeps());
      if (code !== 0) throw new ExitError(code);
    });

  instructions
    .command("list")
    .description(
      "Show which CLAUDE.md / AGENTS.md files carry the block and whether it's in sync",
    )
    .action(async () => {
      const code = await runAgentsMdList(buildDeps());
      if (code !== 0) throw new ExitError(code);
    });

  return agent;
}
