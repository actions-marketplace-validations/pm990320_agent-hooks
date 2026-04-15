import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * GitHub Copilot coding agent. Server-side / remote agent; hooks live
 * at `.github/hooks/*.json` in the repo and are committed.
 * Ref: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks
 */
export const githubCopilot: AgentHandler = {
  name: "github-copilot",
  displayName: "GitHub Copilot coding agent",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "SessionStart",
    "Stop",
    "Notification",
    "UserPromptSubmit",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, _homeDir, fs) {
    const project = path.join(cwd, ".github");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, _homeDir, _scope) {
    return path.join(cwd, ".github", "hooks", "agent-hooks.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "github-copilot",
      "github-copilot",
    );
  },
};
