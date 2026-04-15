import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Windsurf (Codeium). Hook config lives at
 * ~/.codeium/windsurf/hooks.json (user) or workspace equivalents.
 * Each entry has a `command` (bash) and optional platform-specific
 * fields — we normalize to the Claude-style shape.
 */
export const windsurf: AgentHandler = {
  name: "windsurf",
  displayName: "Windsurf (Codeium)",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const user = path.join(homeDir, ".codeium", "windsurf");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    const project = path.join(cwd, ".codeium");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".codeium", "windsurf", "hooks.json")
      : path.join(cwd, ".codeium", "windsurf", "hooks.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "windsurf",
      "windsurf",
    );
  },
};
