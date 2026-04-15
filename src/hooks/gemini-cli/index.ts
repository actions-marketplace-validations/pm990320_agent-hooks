import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Gemini CLI (Google). Richer event surface than Claude: 11 lifecycle
 * events. Config lives at ~/.gemini/settings.json (user) or
 * .gemini/settings.json (project).
 * Ref: https://geminicli.com/docs/hooks/
 */
export const geminiCli: AgentHandler = {
  name: "gemini-cli",
  displayName: "Gemini CLI",
  hookEvents: [
    "SessionStart",
    "SessionEnd",
    "BeforeAgent",
    "AfterAgent",
    "BeforeModel",
    "AfterModel",
    "BeforeToolSelection",
    "BeforeTool",
    "AfterTool",
    "PreCompress",
    "Notification",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".gemini");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".gemini");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".gemini", "settings.json")
      : path.join(cwd, ".gemini", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "gemini-cli",
      "gemini-cli",
    );
  },
};
