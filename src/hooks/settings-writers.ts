import JSON5 from "json5";
import type { Config } from "../config/schema.ts";
import type {
  AgentInstallContext,
  AgentInstallResult,
} from "./types.ts";

/**
 * Reusable helpers for writing agent settings files. Most of the 20+
 * agents we support fall into two shapes:
 *
 *   1. JSON file with a `hooks` object that maps event names to an
 *      array of rules, each with `matcher` + `command`. Claude Code is
 *      the canonical example.
 *   2. Shell stub or plugin file that calls `agent-hooks hook <agent>
 *      <event>` directly.
 *
 * These helpers encode the two shapes so per-agent modules stay small.
 */

// --- Claude-Code-style JSON settings --------------------------------------

export interface ClaudeStyleHookEntry {
  readonly matcher?: string;
  readonly hooks: {
    readonly type: string;
    readonly command: string;
  }[];
}

export interface ClaudeStyleSettings {
  hooks?: Record<string, ClaudeStyleHookEntry[]>;
  [key: string]: unknown;
}

/**
 * Build a Claude-Code-style hooks block from the agent-hooks config.
 * `agentKey` is the key under `config.agents.*` (e.g. "claude-code",
 * "gemini-cli"). `dispatchName` is the hook subcommand we bake into the
 * generated command line (e.g. "claude" → `agent-hooks hook claude`).
 */
export function buildClaudeStyleHooks(
  config: Config,
  agentKey: string,
  dispatchName: string,
): Record<string, ClaudeStyleHookEntry[]> {
  const result: Record<string, ClaudeStyleHookEntry[]> = {};
  const rules = config.agents?.[agentKey]?.hooks ?? {};
  for (const [eventName, ruleList] of Object.entries(rules)) {
    result[eventName] = ruleList.map((rule) => ({
      ...(rule.matcher !== undefined ? { matcher: rule.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: `agent-hooks hook ${dispatchName} ${eventName}`,
        },
      ],
    }));
  }
  return result;
}

/**
 * Merge generated hook entries into an existing settings object. On
 * re-install, any prior entry whose command starts with
 * `agent-hooks hook <dispatchName> <event>` is dropped so we don't
 * accumulate duplicates. Foreign entries are preserved.
 */
export function mergeClaudeStyleSettings(
  existing: Record<string, unknown>,
  generated: Record<string, ClaudeStyleHookEntry[]>,
  dispatchName: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const existingHooks =
    (existing.hooks as
      | Record<string, ClaudeStyleHookEntry[] | undefined>
      | undefined) ?? {};
  const nextHooks: Record<string, ClaudeStyleHookEntry[]> = {};

  // Preserve all existing hook events, filtering out our prior entries.
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!entries) continue;
    const preserved = entries.filter(
      (entry) =>
        !entry.hooks?.some((h) =>
          h.command?.startsWith(`agent-hooks hook ${dispatchName} ${event}`),
        ),
    );
    nextHooks[event] = preserved;
  }
  // Append generated entries.
  for (const [event, entries] of Object.entries(generated)) {
    nextHooks[event] = [...(nextHooks[event] ?? []), ...entries];
  }

  result.hooks = nextHooks;
  return result;
}

/**
 * Read an existing JSON settings file, merge in the generated hook
 * entries, and write the result back. Returns a summary.
 */
export async function installClaudeStyleSettings(
  ctx: AgentInstallContext,
  targetPath: string,
  agentKey: string,
  dispatchName: string,
): Promise<AgentInstallResult> {
  const generated = buildClaudeStyleHooks(ctx.config, agentKey, dispatchName);
  if (Object.keys(generated).length === 0) {
    return { path: targetPath, action: "unchanged" };
  }

  let existing: Record<string, unknown> = {};
  let action: AgentInstallResult["action"] = "created";
  if (await ctx.fs.exists(targetPath)) {
    action = "merged";
    // VS-Code-derived agents (Cursor, Continue, Roo, Kilo) allow //
    // comments and trailing commas in their settings files. JSON5
    // parses both, and any strict-JSON file is also valid JSON5, so
    // it's safe to use for every JSON-style settings target.
    // Note: comments are NOT preserved on rewrite — we own the
    // `hooks` block, but the rest of the file is reformatted as
    // strict JSON. Document this in docs/agents/cursor.md.
    existing = JSON5.parse(await ctx.fs.read(targetPath));
  }

  const merged = mergeClaudeStyleSettings(existing, generated, dispatchName);
  const next = `${JSON.stringify(merged, null, 2)}\n`;
  const prior = action === "merged" ? await ctx.fs.read(targetPath) : "";
  if (prior === next) {
    return { path: targetPath, action: "unchanged" };
  }
  await ctx.fs.mkdirRecursive(dirname(targetPath));
  await ctx.fs.write(targetPath, next);
  return { path: targetPath, action };
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}

// --- Shell stub writer ---------------------------------------------------

export interface ShellStubOptions {
  readonly hookEvents: readonly string[];
  readonly dispatchName: string;
  readonly comment?: string;
}

/**
 * Build a POSIX shell stub that dispatches any of the agent's hook
 * events into agent-hooks. Used by agents that don't have a native
 * JSON settings file and instead fire shell scripts.
 *
 *   #!/bin/sh
 *   # agent-hooks managed stub
 *   EVENT="${1:-$AGENT_HOOKS_EVENT}"
 *   shift || true
 *   exec agent-hooks hook <dispatch> "$EVENT" "$@"
 */
export function buildShellStub(options: ShellStubOptions): string {
  const eventList = options.hookEvents.join("|");
  return `#!/bin/sh
# agent-hooks managed hook stub — do not edit
# dispatch: ${options.dispatchName}
# events:   ${eventList}
${options.comment ? `# ${options.comment}\n` : ""}EVENT="\${1:-$AGENT_HOOKS_EVENT}"
shift 2>/dev/null || true
exec agent-hooks hook ${options.dispatchName} "$EVENT" "$@"
`;
}

/**
 * Helper for shell-stub agents: write the stub file (creating dirs as
 * needed) and return a summary. If `agentKey` is provided and the
 * config has no rules under `agents.<agentKey>.hooks`, the install is
 * a no-op so re-running `agent install <name>` after removing rules
 * doesn't leave a dangling stub.
 */
export async function installShellStub(
  ctx: AgentInstallContext,
  targetPath: string,
  agentKey: string,
  options: ShellStubOptions,
): Promise<AgentInstallResult> {
  const rules = ctx.config.agents?.[agentKey]?.hooks;
  if (!rules || Object.keys(rules).length === 0) {
    return { path: targetPath, action: "unchanged" };
  }
  const contents = buildShellStub(options);
  await ctx.fs.mkdirRecursive(dirname(targetPath));
  let action: AgentInstallResult["action"] = "created";
  if (await ctx.fs.exists(targetPath)) {
    const prior = await ctx.fs.read(targetPath);
    if (prior === contents) {
      return { path: targetPath, action: "unchanged" };
    }
    action = "merged";
  }
  await ctx.fs.write(targetPath, contents);
  return { path: targetPath, action };
}
