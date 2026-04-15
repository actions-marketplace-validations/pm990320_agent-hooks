import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler } from "../types.ts";

/**
 * Kimi Code CLI (Moonshot AI). The native format is TOML
 * (`~/.kimi/config.toml`) rather than JSON. For v0.1 the installer
 * writes a managed JSON sidecar (`~/.kimi/agent-hooks.json`) that the
 * user can reference from their `config.toml` — this avoids clobbering
 * other TOML sections we don't own. Round-tripping TOML natively is
 * future work tracked under the follow-up issue.
 */
export const kimiCodeCli: AgentHandler = {
  name: "kimi-code-cli",
  displayName: "Kimi Code CLI (Moonshot AI)",
  hookEvents: ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"],
  parseInput: parseClaudeStyleInput,
  async detect(cwd, homeDir, fs) {
    const user = path.join(homeDir, ".kimi");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    const project = path.join(cwd, ".kimi");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    return { present: false };
  },
  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".kimi", "agent-hooks.json")
      : path.join(cwd, ".kimi", "agent-hooks.json");
  },
  async install(ctx) {
    return installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "kimi-code-cli",
      "kimi-code-cli",
    );
  },
};
