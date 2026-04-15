import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import { dispatchAgentHook } from "../hooks/dispatch.ts";
import { dispatchGitHook } from "../hooks/git/dispatch.ts";
import { getAgentHandler } from "../hooks/registry.ts";
import { pickReporter } from "../reporters/index.ts";
import { defaultRunDeps, type RunCommandDeps } from "./run.ts";

export interface HookCommandDeps
  extends Pick<
    RunCommandDeps,
    "cwd" | "write" | "writeErr" | "load" | "makeGit" | "exec" | "env"
  > {
  readonly readStdin: () => Promise<string>;
}

/**
 * Input for readStdinStream — a Readable-like object with `isTTY` and
 * event subscription. Accepting a parameter keeps the logic testable
 * without mocking `process.stdin`.
 */
export interface ReadableLike {
  readonly isTTY?: boolean | undefined;
  on(
    event: "data" | "end" | "error",
    cb: (arg?: unknown) => void,
  ): ReadableLike;
}

/**
 * Default upper bound on stdin payloads (16 MB). Real Claude Code /
 * Codex / Cursor hook payloads are well under 100 KB; this exists to
 * shed a buggy or malicious agent that streams indefinitely. Caller
 * can override via the second argument when bigger inputs are
 * legitimate.
 */
export const DEFAULT_STDIN_MAX_BYTES = 16 * 1024 * 1024;

export class StdinTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(
      `stdin exceeded the ${String(maxBytes)}-byte hook input cap. ` +
        `Set AGENT_HOOKS_STDIN_MAX to raise it if your agent legitimately ` +
        `sends larger payloads.`,
    );
    this.name = "StdinTooLargeError";
  }
}

/** Thrown when stdin contains bytes that aren't valid UTF-8. */
export class StdinNotUtf8Error extends Error {
  constructor() {
    super(
      "hook input contained invalid UTF-8 bytes. agent-hooks expects " +
        "JSON or text on stdin from agents — re-encode the upstream payload.",
    );
    this.name = "StdinNotUtf8Error";
  }
}

/**
 * Read stdin (a Readable-like) into a UTF-8 string.
 *
 * Contract: the result is decoded with `fatal: true`, so any byte
 * sequence that isn't valid UTF-8 throws `StdinNotUtf8Error` instead
 * of being silently replaced with U+FFFD. Hook payloads from every
 * supported agent are UTF-8 JSON, so anything else is almost
 * certainly a bug upstream — we'd rather fail loud than corrupt the
 * file paths inside.
 */
export function readStdinStream(
  stream: ReadableLike,
  maxBytes: number = DEFAULT_STDIN_MAX_BYTES,
): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    stream
      .on("data", (chunk: unknown) => {
        let buf: Buffer | null = null;
        if (chunk instanceof Buffer) buf = chunk;
        else if (typeof chunk === "string") buf = Buffer.from(chunk);
        if (!buf) return;
        total += buf.length;
        if (total > maxBytes) {
          reject(new StdinTooLargeError(maxBytes));
          return;
        }
        chunks.push(buf);
      })
      .on("end", () => {
        const merged = Buffer.concat(chunks);
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            merged,
          );
          resolve(text);
        } catch {
          reject(new StdinNotUtf8Error());
        }
      })
      .on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
  });
}

async function loadOrReport(
  deps: HookCommandDeps,
): Promise<LoadedConfig | number> {
  try {
    return await deps.load(deps.cwd);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ConfigNotFoundError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }
}

async function runGit(
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  const loaded = await loadOrReport(deps);
  if (typeof loaded === "number") return loaded;

  const reporter = pickReporter({ env: deps.env, write: deps.write });
  const result = await dispatchGitHook({
    hookName,
    config: loaded.config,
    cwd: deps.cwd,
    env: deps.env,
    git: deps.makeGit(deps.cwd),
    exec: deps.exec,
    reporter,
    write: deps.write,
  });

  if (result.status === "no-rule") return 0;
  if (result.status === "pipeline-missing") {
    deps.writeErr(
      `✗ git hook "${hookName}" references undefined pipeline\n`,
    );
    return 2;
  }
  return result.exitCode;
}

/**
 * The agent key stored in `config.agents.*` doesn't always match the
 * CLI agent name 1:1 (Claude Code uses "claude-code" in config but
 * "claude" on the command line). This table handles that mapping so
 * users can keep writing `hooks: { PostToolUse: [...] }` under
 * `agents.claude-code.hooks` while the CLI stays terse.
 */
const AGENT_CONFIG_KEY_OVERRIDES: Record<string, string> = {
  claude: "claude-code",
};

function configKeyFor(agentName: string): string {
  return AGENT_CONFIG_KEY_OVERRIDES[agentName] ?? agentName;
}

async function runRegisteredAgent(
  agentName: string,
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  const handler = getAgentHandler(agentName);
  if (!handler) {
    deps.writeErr(
      `✗ unknown hook agent: "${agentName}"\n` +
        `  known: git, ${[...new Set(["claude", agentName])].join(", ")}…\n` +
        `  (try 'agent-hooks agent list' for the full set)\n`,
    );
    return 2;
  }

  const loaded = await loadOrReport(deps);
  if (typeof loaded === "number") return loaded;

  const stdin = await deps.readStdin();
  const input = handler.parseInput(stdin);
  const reporter = pickReporter({ env: deps.env, write: deps.write });
  const result = await dispatchAgentHook({
    agentKey: configKeyFor(agentName),
    hookName,
    input,
    config: loaded.config,
    cwd: deps.cwd,
    env: deps.env,
    git: deps.makeGit(deps.cwd),
    exec: deps.exec,
    reporter,
  });

  if (result.status === "no-rule" || result.status === "no-matcher-match") {
    // Exit 0 because no-op is the right behaviour — most agents abort
    // when a hook fails, and we don't want a config that omits a hook
    // event to break every tool call. Keep a one-line note on stderr
    // so the user can see why nothing happened, and a richer message
    // when AGENT_HOOKS_DEBUG=1.
    const reason =
      result.status === "no-rule"
        ? "no rule configured for this event"
        : `no matcher matched tool "${input.toolName ?? "(none)"}"`;
    deps.writeErr(`  ${agentName}/${hookName}: ${reason}\n`);
    if (deps.env.AGENT_HOOKS_DEBUG === "1") {
      const rules =
        loaded.config.agents?.[configKeyFor(agentName)]?.hooks?.[hookName] ??
        [];
      deps.writeErr(
        `  (configured rules: ${String(rules.length)}; tool: ${
          input.toolName ?? "(none)"
        })\n`,
      );
    }
    return 0;
  }
  if (result.status === "pipeline-missing") {
    deps.writeErr(
      `✗ ${agentName} hook "${hookName}" references undefined pipeline\n`,
    );
    return 2;
  }
  return result.exitCode;
}

export async function runHookCommand(
  agent: string,
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  if (agent === "git") return runGit(hookName, deps);
  return runRegisteredAgent(agent, hookName, deps);
}

/**
 * Implement `agent-hooks hook <agent> --list`: enumerate every hook
 * event the handler supports and mark the ones that have at least one
 * rule configured in `.config/agent-hooks.yml` under
 * `agents.<key>.hooks.<event>`. Also lists each rule's matcher +
 * pipeline so users can see what will fire without shelling in and
 * grepping the config themselves.
 *
 * Exits 0 on success, 2 on unknown-agent or config-load failure.
 */
export async function runHookListCommand(
  agent: string,
  deps: HookCommandDeps,
): Promise<number> {
  if (agent === "git") {
    // Git hooks live in config.git.hooks, not config.agents.git — the
    // shape differs enough that --list doesn't carry over cleanly. For
    // now just point users at doctor, which already surfaces this.
    deps.writeErr(
      `✗ hook --list doesn't support the git agent yet. ` +
        `Run 'agent-hooks doctor' to see installed git hooks.\n`,
    );
    return 2;
  }
  const handler = getAgentHandler(agent);
  if (!handler) {
    deps.writeErr(
      `✗ unknown hook agent: "${agent}"\n` +
        `  (try 'agent-hooks agent list' for the full set)\n`,
    );
    return 2;
  }
  const loaded = await loadOrReport(deps);
  if (typeof loaded === "number") return loaded;

  const configKey = configKeyFor(agent);
  const configuredHooks =
    loaded.config.agents?.[configKey]?.hooks ?? {};

  deps.write(`${handler.displayName} (${agent}):\n`);
  for (const event of handler.hookEvents) {
    const rules = configuredHooks[event] ?? [];
    const glyph = rules.length > 0 ? "✓" : "·";
    const count =
      rules.length > 0 ? ` (${String(rules.length)} rule${rules.length === 1 ? "" : "s"})` : "";
    deps.write(`  ${glyph} ${event}${count}\n`);
    for (const rule of rules) {
      const matcher = rule.matcher ?? "*";
      deps.write(`      matcher: ${matcher} → pipeline: ${rule.pipeline}\n`);
    }
  }

  // Surface configured events the handler doesn't recognize — a common
  // source of silent no-ops is a typo'd event name (PostToolUSE vs
  // PostToolUse). Call them out so the user can fix the config.
  const known = new Set(handler.hookEvents);
  const orphans = Object.keys(configuredHooks).filter(
    (name) => !known.has(name),
  );
  if (orphans.length > 0) {
    deps.write(
      `\n  ⚠ configured events not recognized by ${handler.displayName}:\n`,
    );
    for (const orphan of orphans) {
      deps.write(`      - ${orphan}\n`);
    }
  }
  return 0;
}

export function registerHookCommand(
  program: Command,
  overrides: Partial<HookCommandDeps> = {},
): Command {
  return program
    .command("hook")
    .description("Canonical entry point for every agent hook")
    .argument("<agent>", "agent name — e.g. git, claude, gemini-cli")
    .argument(
      "[hook-name]",
      "hook name native to the agent (omit when using --list)",
    )
    .option(
      "--list",
      "list supported hook events and currently configured rules for the agent",
    )
    .action(async function (
      this: Command,
      agent: string,
      hookName: string | undefined,
    ) {
      const flags = this.opts<{ list?: boolean }>();
      const deps: HookCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultRunDeps.write,
        writeErr: overrides.writeErr ?? defaultRunDeps.writeErr,
        load: overrides.load ?? defaultRunDeps.load,
        makeGit: overrides.makeGit ?? defaultRunDeps.makeGit,
        exec: overrides.exec ?? defaultRunDeps.exec,
        env: overrides.env ?? defaultRunDeps.env,
        readStdin:
          overrides.readStdin ??
          (() => readStdinStream(process.stdin)),
      };
      if (flags.list) {
        const code = await runHookListCommand(agent, deps);
        if (code !== 0) throw new ExitError(code);
        return;
      }
      if (!hookName) {
        deps.writeErr(
          `✗ hook <agent> requires <hook-name> (or --list to enumerate events)\n`,
        );
        throw new ExitError(2);
      }
      const code = await runHookCommand(agent, hookName, deps);
      if (code !== 0) throw new ExitError(code);
    });
}
