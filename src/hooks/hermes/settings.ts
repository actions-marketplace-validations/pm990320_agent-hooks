import path from "node:path";
import YAML from "yaml";
import type { Config } from "../../config/schema.ts";
import type { AgentInstallContext, AgentInstallResult } from "../types.ts";

/**
 * Write hooks into Hermes Agent's `~/.hermes/config.yaml`.
 *
 * Hermes loads hooks from one file: `~/.hermes/config.yaml`. The
 * `hooks:` block maps each event name to a list of `{matcher?,
 * command, timeout?}` entries — flatter than Claude Code's nested
 * shape. We use `YAML.parseDocument` (not `YAML.parse`) so the
 * surrounding config — providers, sandboxing, gateway settings —
 * keeps its comments and key order on rewrite. The user's hand-edited
 * config.yaml is the canonical source for everything except the
 * hooks block; we only own that.
 *
 * Ref: agent/shell_hooks.py and
 * https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md
 */

interface HermesHookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

const DISPATCH_NAME = "hermes";
const AGENT_KEY = "hermes";

function buildHermesHooks(
  config: Config,
): Record<string, HermesHookEntry[]> {
  const result: Record<string, HermesHookEntry[]> = {};
  const rules = config.agents?.[AGENT_KEY]?.hooks ?? {};
  for (const [eventName, ruleList] of Object.entries(rules)) {
    result[eventName] = ruleList.map((rule) => ({
      ...(rule.matcher !== undefined ? { matcher: rule.matcher } : {}),
      command: `agent-hooks hook ${DISPATCH_NAME} ${eventName}`,
    }));
  }
  return result;
}

/**
 * Identify our own managed entries inside an existing hermes hooks
 * list so re-installing replaces them rather than accumulating.
 * Foreign entries (anything whose command does NOT start with
 * `agent-hooks hook hermes <event>`) are preserved verbatim — users
 * may have unrelated guardrails or auto-format hooks alongside ours.
 */
function isOurEntry(entry: unknown, eventName: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const command = (entry as { command?: unknown }).command;
  if (typeof command !== "string") return false;
  return command.startsWith(`agent-hooks hook ${DISPATCH_NAME} ${eventName}`);
}

export async function installHermesSettings(
  ctx: AgentInstallContext,
  targetPath: string,
): Promise<AgentInstallResult> {
  const generated = buildHermesHooks(ctx.config);
  if (Object.keys(generated).length === 0) {
    return { path: targetPath, action: "unchanged" };
  }

  let action: AgentInstallResult["action"] = "created";
  let prior = "";
  if (await ctx.fs.exists(targetPath)) {
    action = "merged";
    prior = await ctx.fs.read(targetPath);
  }

  // Bootstrap a doc whose contents is always a top-level map so the
  // create/merge paths share one code shape. `parseDocument("{}")`
  // produces an empty parsed flow map; if the user's existing file
  // is already a mapping, we get their map (with comments etc.)
  // instead. We widen to `YAML.Document` because `Document.Parsed`'s
  // strict generic types reject the plain Nodes we pass to .set().
  const seed = prior.length === 0 ? "{}" : prior;
  const parsed = YAML.parseDocument(seed);
  if (parsed.errors.length > 0) {
    // Surface as SyntaxError so the agent install command remaps it
    // to exit 2 with a helpful message, matching how
    // installClaudeStyleSettings reports JSON parse failures.
    throw new SyntaxError(
      `${targetPath}: ${parsed.errors[0]?.message ?? "invalid YAML"}`,
    );
  }
  const document: YAML.Document = parsed;

  const rootNode = document.contents;
  if (!YAML.isMap(rootNode)) {
    throw new SyntaxError(
      `${targetPath}: top-level YAML must be a mapping, got ${
        rootNode === null ? "null" : rootNode.constructor.name
      }`,
    );
  }

  const existingHooksNode = rootNode.get("hooks", true);
  const nextHooks: Record<string, HermesHookEntry[]> = {};

  if (YAML.isMap(existingHooksNode)) {
    for (const item of existingHooksNode.items) {
      const key = YAML.isScalar(item.key)
        ? String(item.key.value)
        : String(item.key);
      const list = item.value;
      if (!YAML.isSeq(list)) continue;
      const preserved: HermesHookEntry[] = [];
      for (const entry of list.items) {
        const plain: unknown =
          YAML.isMap(entry) || YAML.isSeq(entry)
            ? (entry.toJSON() as unknown)
            : YAML.isScalar(entry)
              ? entry.value
              : entry;
        if (isOurEntry(plain, key)) continue;
        preserved.push(plain as HermesHookEntry);
      }
      nextHooks[key] = preserved;
    }
  }

  for (const [event, entries] of Object.entries(generated)) {
    nextHooks[event] = [...(nextHooks[event] ?? []), ...entries];
  }

  rootNode.set("hooks", document.createNode(nextHooks));

  const next = document.toString();
  if (action === "merged" && prior === next) {
    return { path: targetPath, action: "unchanged" };
  }

  await ctx.fs.mkdirRecursive(path.dirname(targetPath));
  await ctx.fs.write(targetPath, next);
  return { path: targetPath, action };
}
