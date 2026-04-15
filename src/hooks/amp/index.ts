import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Amp (Sourcegraph). Hook config lives inside `.vscode/settings.json`
 * under an `amp.hooks` array. We reuse the Claude-style settings
 * writer since the core shape is still "JSON file, hooks block".
 */
export const amp: AgentHandler = {
  name: "amp",
  displayName: "Amp (Sourcegraph)",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "Stop",
    "UserPromptSubmit",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, _homeDir, fs) {
    const vscode = path.join(cwd, ".vscode");
    if (await fs.exists(vscode)) {
      return { present: true, scope: "project", path: vscode };
    }
    return { present: false };
  },
  settingsPath(cwd, _homeDir, _scope) {
    return path.join(cwd, ".vscode", "settings.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "amp",
      "amp",
    );
  },
};
