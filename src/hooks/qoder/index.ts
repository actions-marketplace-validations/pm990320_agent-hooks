import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Qoder. Hook entries live in the Qoder agent config and point at
 * script files on disk. We ship a single shell dispatcher stub under
 * `.qoder/hooks/agent-hooks.sh` that handles every event via the
 * first CLI arg.
 */
export const qoder: AgentHandler = {
  name: "qoder",
  displayName: "Qoder",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".qoder");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".qoder");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".qoder", "hooks", "agent-hooks.sh")
      : path.join(cwd, ".qoder", "hooks", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "qoder",
      { hookEvents: this.hookEvents, dispatchName: "qoder" },
    );
  },
};
