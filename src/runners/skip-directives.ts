/**
 * Skip directives — layered escape hatches that decide which steps run
 * for a given pipeline invocation. Resolution order (highest precedence
 * first, where the first non-empty answer wins):
 *
 *   1. CLI flags (--skip / --only)
 *   2. Env vars (AGENT_HOOKS_SKIP, AGENT_HOOKS_ONLY)
 *   3. Commit message tags ([skip agent-hooks], [skip <step>], etc.)
 *   4. Pipeline tag filters (already applied by the pipeline runner)
 */

export type SkipDirectiveSource =
  | { kind: "cli" }
  | { kind: "env"; name: string }
  | { kind: "commit-message"; tag: string };

export interface ResolvedSkipDirectives {
  /** Step names to skip — combined from every layer. */
  readonly skip: ReadonlySet<string>;
  /** Step names allowed to run (empty = no whitelist). */
  readonly only: ReadonlySet<string>;
  /** True when "skip everything" was requested at any layer. */
  readonly skipAll: boolean;
  /** Origin notes for each directive — used by reporters/loggers. */
  readonly sources: readonly { directive: string; from: SkipDirectiveSource }[];
}

const ALL_SKIP_TOKENS = new Set([
  "agent-hooks",
  "ci",
  "all",
]);

/**
 * Parse `[skip <names>]` and `[agent-hooks skip <names>]` style tokens
 * from a commit message. Returns the union of step names called out
 * across every match, plus a `skipAll` flag if any of them named
 * `agent-hooks`, `ci`, or `all`.
 */
export function parseCommitMessageSkips(message: string): {
  skip: Set<string>;
  skipAll: boolean;
  matches: string[];
} {
  const skip = new Set<string>();
  let skipAll = false;
  const matches: string[] = [];

  // [skip foo,bar] / [skip foo bar] / [skip ci] / [skip agent-hooks]
  const skipPattern = /\[skip\s+([^\]]+)\]/gi;
  // [agent-hooks skip foo,bar]
  const alt = /\[agent-hooks\s+skip(?:\s+([^\]]*))?\]/gi;

  for (const match of message.matchAll(skipPattern)) {
    matches.push(match[0]);
    const tokens = (match[1] ?? "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    for (const token of tokens) {
      if (ALL_SKIP_TOKENS.has(token.toLowerCase())) {
        skipAll = true;
      } else {
        skip.add(token);
      }
    }
  }

  for (const match of message.matchAll(alt)) {
    matches.push(match[0]);
    const tokens = (match[1] ?? "")
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (tokens.length === 0) {
      // Bare [agent-hooks skip] = skip everything
      skipAll = true;
      continue;
    }
    for (const token of tokens) {
      if (ALL_SKIP_TOKENS.has(token.toLowerCase())) {
        skipAll = true;
      } else {
        skip.add(token);
      }
    }
  }

  return { skip, skipAll, matches };
}

/**
 * Parse the AGENT_HOOKS_SKIP env var. `=1` (or `true`/`yes`) skips
 * everything. Otherwise the value is a comma-separated list of step
 * names.
 */
export function parseSkipEnvValue(value: string): {
  skip: Set<string>;
  skipAll: boolean;
} {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { skip: new Set(), skipAll: false };
  const lower = trimmed.toLowerCase();
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "all") {
    return { skip: new Set(), skipAll: true };
  }
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { skip: new Set(parts), skipAll: false };
}

export interface ResolveDirectivesOptions {
  /** CLI --skip names. */
  readonly cliSkip?: readonly string[];
  /** CLI --only names. */
  readonly cliOnly?: readonly string[];
  /** Process env, used to look up AGENT_HOOKS_SKIP / AGENT_HOOKS_ONLY. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Commit message text (HEAD's last commit, or the staged message). */
  readonly commitMessage?: string;
}

/**
 * Resolve the effective skip + only sets for a pipeline invocation by
 * layering CLI flags, env vars, and commit message tags. Order of
 * precedence: CLI > env > commit message. Sets union across layers.
 */
export function resolveSkipDirectives(
  options: ResolveDirectivesOptions,
): ResolvedSkipDirectives {
  const skip = new Set<string>();
  const only = new Set<string>();
  let skipAll = false;
  const sources: { directive: string; from: SkipDirectiveSource }[] = [];

  // CLI layer
  for (const name of options.cliSkip ?? []) {
    skip.add(name);
    sources.push({ directive: name, from: { kind: "cli" } });
  }
  for (const name of options.cliOnly ?? []) {
    only.add(name);
    sources.push({ directive: `only ${name}`, from: { kind: "cli" } });
  }

  // Env layer
  const env = options.env ?? {};
  const envSkipRaw = env.AGENT_HOOKS_SKIP;
  if (typeof envSkipRaw === "string" && envSkipRaw.length > 0) {
    const parsed = parseSkipEnvValue(envSkipRaw);
    if (parsed.skipAll) skipAll = true;
    for (const name of parsed.skip) {
      skip.add(name);
      sources.push({
        directive: name,
        from: { kind: "env", name: "AGENT_HOOKS_SKIP" },
      });
    }
  }
  const envOnlyRaw = env.AGENT_HOOKS_ONLY;
  if (typeof envOnlyRaw === "string" && envOnlyRaw.length > 0) {
    for (const name of envOnlyRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      only.add(name);
      sources.push({
        directive: `only ${name}`,
        from: { kind: "env", name: "AGENT_HOOKS_ONLY" },
      });
    }
  }

  // Commit message layer
  if (options.commitMessage) {
    const parsed = parseCommitMessageSkips(options.commitMessage);
    if (parsed.skipAll) {
      skipAll = true;
      sources.push({
        directive: "skip-all",
        from: { kind: "commit-message", tag: "all" },
      });
    }
    for (const name of parsed.skip) {
      skip.add(name);
      sources.push({
        directive: name,
        from: { kind: "commit-message", tag: name },
      });
    }
  }

  return { skip, only, skipAll, sources };
}
