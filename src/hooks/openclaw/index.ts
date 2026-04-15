import path from "node:path";
import { parsePluginContextInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * OpenClaw. Native TypeScript hook modules loaded from a `hooks/`
 * directory. We ship a shell dispatcher under
 * `hooks/agent-hooks/handler.sh` that the TS shim fires fire-and-forget
 * async with a serialized context JSON on stdin.
 */
export const openclaw: AgentHandler = {
  name: "openclaw",
  displayName: "OpenClaw",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ],
  parseInput: parsePluginContextInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, "hooks");
    // Heuristic — check for a sibling openclaw marker.
    const marker = path.join(cwd, ".openclaw");
    if (await fs.exists(marker)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".openclaw");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".openclaw", "hooks", "agent-hooks.sh")
      : path.join(cwd, "hooks", "agent-hooks", "handler.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "openclaw",
      { hookEvents: this.hookEvents, dispatchName: "openclaw" },
    );
  },
};
