import type { Command } from "commander";
import { renderConfigJSONSchema } from "../config/to-json-schema.ts";

export interface SchemaCommandDeps {
  /** Writer used by the command action. Injected for tests. */
  readonly write: (text: string) => void;
}

export const defaultSchemaDeps: SchemaCommandDeps = {
  write(text) {
    process.stdout.write(text);
  },
};

export function registerSchemaCommand(
  program: Command,
  deps: SchemaCommandDeps = defaultSchemaDeps,
): Command {
  return program
    .command("schema")
    .description("Print the JSON Schema for the agent-hooks config file")
    .action(() => {
      deps.write(renderConfigJSONSchema());
    });
}
