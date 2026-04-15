import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Claude Code hook handler. Stdin JSON, config at `.claude/settings.json`
 * (project) or `~/.claude/settings.json` (user).
 *
 * Events per Claude Code docs: PreToolUse, PostToolUse, UserPromptSubmit,
 * Stop, SubagentStop, Notification, PreCompact.
 */
export const claude: AgentHandler = {
  name: "claude",
  displayName: "Claude Code",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "SubagentStop",
    "Notification",
    "PreCompact",
  ],

  parseInput: parseClaudeStyleInput,

  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".claude");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".claude");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },

  settingsPath(cwd, homeDir, scope) {
    if (scope === "user") {
      return path.join(homeDir, ".claude", "settings.json");
    }
    return path.join(cwd, ".claude", "settings.json");
  },

  async install(ctx) {
    const target = this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope);
    return installClaudeStyleSettings(ctx, target, "claude-code", "claude");
  },
};
