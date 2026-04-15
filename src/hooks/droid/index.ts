import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Droid (Factory AI). Hook schema is a near-superset of Claude Code's
 * — same matcher+command entries. Config at ~/.factory/settings.json.
 * Ref: https://docs.factory.ai/cli/configuration/hooks-guide
 */
export const droid: AgentHandler = {
  name: "droid",
  displayName: "Droid (Factory AI)",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
    "Notification",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const user = path.join(homeDir, ".factory");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    const project = path.join(cwd, ".factory");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".factory", "settings.json")
      : path.join(cwd, ".factory", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "droid",
      "droid",
    );
  },
};
