import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Kiro (AWS). JSON settings file with matcher-driven hook entries.
 * Config detected via `.kiro/` directory.
 */
export const kiro: AgentHandler = {
  name: "kiro",
  displayName: "Kiro (AWS)",
  hookEvents: ["PreToolUse", "PostToolUse", "SessionStart", "Stop"],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".kiro");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".kiro");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".kiro", "settings.json")
      : path.join(cwd, ".kiro", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "kiro",
      "kiro",
    );
  },
};
