import path from "node:path";
import { parsePluginContextInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Neovate. Plugin-only: TypeScript plugin hooks receive context
 * objects, no shell command surface. We ship a shell dispatcher stub
 * that the shim plugin calls with a JSON-serialized context on stdin.
 */
export const neovate: AgentHandler = {
  name: "neovate",
  displayName: "Neovate",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit"],
  parseInput: parsePluginContextInput,
  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".neovate");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".neovate");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".neovate", "plugins", "agent-hooks.sh")
      : path.join(cwd, ".neovate", "plugins", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "neovate",
      { hookEvents: this.hookEvents, dispatchName: "neovate" },
    );
  },
};
