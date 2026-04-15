import path from "node:path";
import { parsePluginContextInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Pi (pi-mono). TypeScript-module hooks. We ship a shell stub under
 * `~/.pi/agent/agent-hooks.sh` that the TS shim invokes with a
 * serialized HookAPI context on stdin.
 */
export const pi: AgentHandler = {
  name: "pi",
  displayName: "Pi (pi-mono)",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"],
  parseInput: parsePluginContextInput,
  async detect(cwd, homeDir, fs) {
    const user = path.join(homeDir, ".pi");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    const project = path.join(cwd, ".pi");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".pi", "agent", "agent-hooks.sh")
      : path.join(cwd, ".pi", "agent", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "pi",
      { hookEvents: this.hookEvents, dispatchName: "pi" },
    );
  },
};
