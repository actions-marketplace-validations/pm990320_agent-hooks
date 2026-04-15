import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Cortex Code (Snowflake). JSON settings file. Supports both `command`
 * and `prompt` hook action types — v0.1 only wires the `command` path;
 * prompt-injection is future work.
 */
export const cortexCode: AgentHandler = {
  name: "cortex-code",
  displayName: "Cortex Code (Snowflake)",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".cortex");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".cortex");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".cortex", "settings.json")
      : path.join(cwd, ".cortex", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "cortex-code",
      "cortex-code",
    );
  },
};
