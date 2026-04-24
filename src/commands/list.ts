/**
 * `agent-hooks list` — show every step and pipeline defined in the
 * loaded config, plus their descriptions, tags, and `fix:` commands
 * when present. Per PLAN §4 line 267: "List steps and pipelines with
 * descriptions."
 *
 * This is a discovery command for agents and humans alike — it's the
 * fastest way to answer "what can I run here?" without opening the
 * config file.
 */

import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import { loadConfig, type LoadedConfig } from "../config/load.ts";
import { loadProjectConfig, type LoadedProject } from "../config/project.ts";
import type { Pipeline, Step } from "../config/schema.ts";

export interface ListCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly load: (cwd: string) => Promise<LoadedConfig>;
  readonly loadProject?: (cwd: string) => Promise<LoadedProject>;
}

export async function runListCommand(deps: ListCommandDeps): Promise<number> {
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

  if (project.mode === "monorepo") {
    deps.write(`project mode: monorepo\n`);
    deps.write(`root config: ${project.root.sourcePath}\n`);
    deps.write(`workspaces (${String(project.workspaces.length)}):\n`);
    for (const workspace of project.workspaces) {
      deps.write(`  - ${workspace.relativePath} (${workspace.sourcePath})\n`);
    }
    for (const warning of project.warnings) {
      deps.write(`  ⚠ ${warning}\n`);
    }
    deps.write("\n");
    writeConfigListing(deps.write, "root", project.root);
    for (const workspace of project.workspaces) {
      deps.write("\n");
      writeConfigListing(
        deps.write,
        `workspace ${workspace.relativePath}`,
        workspace,
      );
    }
    return 0;
  }

  writeConfigListing(deps.write, null, project.loaded);
  return 0;
}

function writeConfigListing(
  write: (text: string) => void,
  heading: string | null,
  loaded: LoadedConfig,
): void {
  const config = loaded.config;
  const stepEntries = Object.entries(config.steps);
  const pipelineEntries = Object.entries(config.pipelines);

  if (heading) {
    write(`${heading}:\n`);
    write(`  config: ${loaded.sourcePath}\n`);
    if (loaded.localPath) {
      write(`  local override: ${loaded.localPath}\n`);
    }
  }

  if (config.name) {
    write(`project: ${config.name}\n\n`);
  }

  write(`steps (${String(stepEntries.length)}):\n`);
  if (stepEntries.length === 0) {
    write(`  (none defined)\n`);
  } else {
    const nameWidth = longest(stepEntries.map(([name]) => name));
    for (const [name, step] of stepEntries) {
      write(formatStepLine(name, step, nameWidth));
    }
  }

  write(`\npipelines (${String(pipelineEntries.length)}):\n`);
  if (pipelineEntries.length === 0) {
    write(`  (none defined)\n`);
  } else {
    const nameWidth = longest(pipelineEntries.map(([name]) => name));
    for (const [name, pipeline] of pipelineEntries) {
      write(formatPipelineLine(name, pipeline, nameWidth));
    }
  }
}

function longest(names: readonly string[]): number {
  let max = 0;
  for (const name of names) {
    if (name.length > max) max = name.length;
  }
  return max;
}

function formatStepLine(name: string, step: Step, nameWidth: number): string {
  const pad = name.padEnd(nameWidth);
  const parts: string[] = [];
  if (step.description) parts.push(step.description);
  if (step.tags.length > 0) parts.push(`[${step.tags.join(", ")}]`);
  if (step.fix) parts.push("(has --fix)");
  const suffix = parts.length > 0 ? ` — ${parts.join(" ")}` : "";
  return `  ${pad}${suffix}\n`;
}

function formatPipelineLine(
  name: string,
  pipeline: Pipeline,
  nameWidth: number,
): string {
  const pad = name.padEnd(nameWidth);
  const parts: string[] = [];
  if (pipeline.description) parts.push(pipeline.description);
  parts.push(`${String(pipeline.steps.length)} step${pipeline.steps.length === 1 ? "" : "s"}`);
  if (pipeline.parallel) parts.push("parallel");
  if (pipeline["exclude-tags"].length > 0) {
    parts.push(`excludes [${pipeline["exclude-tags"].join(", ")}]`);
  }
  if (pipeline["include-tags"].length > 0) {
    parts.push(`includes [${pipeline["include-tags"].join(", ")}]`);
  }
  return `  ${pad} — ${parts.join(" · ")}\n`;
}

export function registerListCommand(
  program: Command,
  overrides: Partial<ListCommandDeps> = {},
): Command {
  return program
    .command("list")
    .description("List steps and pipelines defined in the loaded config")
    .action(async () => {
      const deps: ListCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? ((text) => process.stdout.write(text)),
        writeErr:
          overrides.writeErr ?? ((text) => process.stderr.write(text)),
        load: overrides.load ?? ((cwd) => loadConfig({ cwd })),
        ...(
          overrides.loadProject !== undefined
            ? { loadProject: overrides.loadProject }
            : overrides.load === undefined
              ? { loadProject: (cwd: string) => loadProjectConfig({ cwd }) }
              : {}
        ),
      };
      const code = await runListCommand(deps);
      if (code !== 0) throw new ExitError(code);
    });
}
