import path from "node:path";
import { parsePluginContextInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * OpenCode. SDK-driven plugin system — plugins live under
 * `.opencode/plugins/` (project) or `~/.config/opencode/plugins/`
 * (user). Our installer ships a thin shell stub that the plugin
 * invokes with a serialized plugin context JSON on stdin.
 * Ref: https://opencode.ai/docs/plugins/
 */
export const opencode: AgentHandler = {
  name: "opencode",
  displayName: "OpenCode",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ],
  parseInput: parsePluginContextInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".opencode");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".config", "opencode");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    if (scope === "user") {
      return path.join(
        homeDir,
        ".config",
        "opencode",
        "plugins",
        "agent-hooks.sh",
      );
    }
    return path.join(cwd, ".opencode", "plugins", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "opencode",
      {
        hookEvents: this.hookEvents,
        dispatchName: "opencode",
        comment: "Invoked by OpenCode plugin wrapper",
      },
    );
  },
};
