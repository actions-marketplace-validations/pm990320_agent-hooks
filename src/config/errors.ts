export class ConfigError extends Error {
  readonly path: string | null;
  readonly details: string | null;

  constructor(
    message: string,
    options: { path?: string | null; details?: string | null } = {},
  ) {
    super(message);
    this.name = "ConfigError";
    this.path = options.path ?? null;
    this.details = options.details ?? null;
  }
}

export class ConfigNotFoundError extends ConfigError {
  readonly searched: readonly string[];

  constructor(cwd: string, searched: readonly string[]) {
    super(`No agent-hooks config file found under ${cwd}`, {
      details: `Searched:\n${searched.map((p) => `  - ${p}`).join("\n")}`,
    });
    this.name = "ConfigNotFoundError";
    this.searched = searched;
  }
}
