import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installShellStub } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallResult } from "../types.ts";

/**
 * Augment Code. Script-per-hook-event directory layout: one shell
 * script per event under `~/.augment/hooks/`. We ship a single
 * dispatcher stub that handles every event via the first CLI arg.
 */
export const augmentCode: AgentHandler = {
  name: "augment-code",
  displayName: "Augment Code",
  hookEvents: [
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "Stop",
  ],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const user = path.join(homeDir, ".augment");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    const project = path.join(cwd, ".augment");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".augment", "hooks", "agent-hooks.sh")
      : path.join(cwd, ".augment", "hooks", "agent-hooks.sh");
  },
  async install(ctx): Promise<AgentInstallResult> {
    return installShellStub(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "augment-code",
      { hookEvents: this.hookEvents, dispatchName: "augment-code" },
    );
  },
};
