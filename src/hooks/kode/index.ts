import path from "node:path";
import { parsePluginContextInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Kode (shareAI-lab). SDK-driven, event-based. We ship a shell stub
 * that the SDK shim invokes with the event JSON on stdin so agent-hooks
 * can dispatch it uniformly with other agents.
 */
export const kode: AgentHandler = {
  name: "kode",
  displayName: "Kode (shareAI-lab)",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"],
  parseInput: parsePluginContextInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".kode");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".kode");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".kode", "hooks", "agent-hooks.sh")
      : path.join(cwd, ".kode", "hooks", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "kode",
      { hookEvents: this.hookEvents, dispatchName: "kode" },
    );
  },
};
