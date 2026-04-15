import { Command, CommanderError } from "commander";
import { registerAgentCommand } from "./commands/agent.ts";
import { registerBeadsCommand } from "./commands/beads.ts";
import { registerDoctorCommand } from "./commands/doctor.ts";
import { registerFixCommand } from "./commands/fix.ts";
import { registerHookCommand } from "./commands/hook.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerInstallCommand } from "./commands/install.ts";
import { registerListCommand } from "./commands/list.ts";
import {
  registerCiCommand,
  registerRunCommand,
  registerShortcutCommand,
} from "./commands/run.ts";
import { registerSchemaCommand } from "./commands/schema.ts";
import { NAME, VERSION } from "./version.ts";

/**
 * Thrown from command actions to set an explicit process exit code without
 * treating the outcome as an uncaught error. `runProgram` catches it and
 * returns the code to the caller.
 */
export class ExitError extends Error {
  constructor(readonly exitCode: number) {
    super(`exit code ${exitCode}`);
    this.name = "ExitError";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(NAME)
    .description(
      "One command for CI, pre-commit hooks, and agent feedback loops.",
    )
    .version(VERSION)
    .exitOverride();
  registerSchemaCommand(program);
  registerDoctorCommand(program);
  registerInitCommand(program);
  registerInstallCommand(program);
  registerHookCommand(program);
  registerAgentCommand(program);
  registerBeadsCommand(program);
  registerRunCommand(program);
  registerCiCommand(program);
  registerFixCommand(program);
  registerListCommand(program);
  registerShortcutCommand(program, "lint", "Shortcut for `run lint`");
  registerShortcutCommand(program, "test", "Shortcut for `run test`");
  registerShortcutCommand(program, "build", "Shortcut for `run build`");
  registerShortcutCommand(
    program,
    "typecheck",
    "Shortcut for `run typecheck`",
  );
  registerShortcutCommand(program, "format", "Shortcut for `run format`");
  return program;
}

export async function runProgram(
  program: Command,
  argv: readonly string[],
): Promise<number> {
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    if (err instanceof ExitError) return err.exitCode;
    return 1;
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  return runProgram(buildProgram(), argv);
}
