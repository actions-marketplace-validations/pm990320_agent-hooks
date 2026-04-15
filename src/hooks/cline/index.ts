import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Cline (VS Code extension). Per-project hook scripts live in
 * `.clinerules/hooks/`; user-wide scripts live in
 * `~/Documents/Cline/Rules/Hooks/`. We ship a single shell stub per
 * repo that dispatches every event through `agent-hooks hook cline
 * <event>`.
 * Ref: https://docs.cline.bot/customization/hooks
 */
export const cline: AgentHandler = {
  name: "cline",
  displayName: "Cline",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "TaskStart",
    "TaskResume",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".clinerules");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, "Documents", "Cline");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    if (scope === "user") {
      return path.join(
        homeDir,
        "Documents",
        "Cline",
        "Rules",
        "Hooks",
        "agent-hooks.sh",
      );
    }
    return path.join(cwd, ".clinerules", "hooks", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    const target = this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope);
    return installShellStub(ctx, target, "cline", {
      hookEvents: this.hookEvents,
      dispatchName: "cline",
    });
  },
};
