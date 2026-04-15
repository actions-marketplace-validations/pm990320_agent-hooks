import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/** iFlow CLI. Hierarchical config: .iflow/settings.json (project) merged
 * over ~/.iflow/settings.json (user). */
export const iflowCli: AgentHandler = {
  name: "iflow-cli",
  displayName: "iFlow CLI",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".iflow");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".iflow");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".iflow", "settings.json")
      : path.join(cwd, ".iflow", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "iflow-cli",
      "iflow-cli",
    );
  },
};
