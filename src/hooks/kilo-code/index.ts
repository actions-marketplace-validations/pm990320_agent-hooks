import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/** Kilo Code. Local hooks live in the agent config file. Cloud
 * webhooks are deferred. */
export const kiloCode: AgentHandler = {
  name: "kilo-code",
  displayName: "Kilo Code",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".kilo");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".kilo");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".kilo", "settings.json")
      : path.join(cwd, ".kilo", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "kilo-code",
      "kilo-code",
    );
  },
};
