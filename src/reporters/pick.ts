import { createConsoleReporter } from "./console.ts";
import { createGitHubActionsReporter } from "./github-actions.ts";
import type { Reporter, Writer } from "./index.ts";

export interface PickReporterOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write: Writer;
  /** Force a specific reporter regardless of env. */
  readonly forceKind?: "console" | "github-actions";
}

/**
 * Decide which reporter to use for the current context. Agents and
 * GitHub Actions get structured reporters; everyone else gets the
 * plain console reporter.
 */
export function pickReporter(options: PickReporterOptions): Reporter {
  if (options.forceKind === "console") {
    return createConsoleReporter(options.write);
  }
  if (options.forceKind === "github-actions") {
    return createGitHubActionsReporter(options.write);
  }
  if (options.env.GITHUB_ACTIONS === "true") {
    return createGitHubActionsReporter(options.write);
  }
  return createConsoleReporter(options.write);
}
