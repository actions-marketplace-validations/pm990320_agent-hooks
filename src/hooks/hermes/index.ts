import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import type { AgentHandler } from "../types.ts";
import { installHermesSettings } from "./settings.ts";

/**
 * Hermes Agent (Nous Research). Shell-hook system loaded exclusively
 * from `~/.hermes/config.yaml` — there's no project-local config that
 * hermes itself reads. The stdin payload shape (`hook_event_name`,
 * `tool_name`, `tool_input`, `session_id`, `cwd`, `extra`) is a
 * superset of Claude Code's, so `parseClaudeStyleInput` covers it.
 *
 * Notably hermes does NOT use exit-code feedback: agent/shell_hooks.py
 * logs non-zero exits as warnings but never blocks the agent loop, and
 * the model only sees responses when the hook writes JSON to stdout
 * (`{"decision": "block", ...}` or `{"context": "..."}`). That means
 * we leave `stderrFeedbackOnExit2` unset so pipeline failures pass
 * their exit code through verbatim instead of being remapped to 2.
 *
 * Ref: https://github.com/NousResearch/hermes-agent —
 *      website/docs/user-guide/features/hooks.md and
 *      agent/shell_hooks.py.
 */
export const hermes: AgentHandler = {
  name: "hermes",
  displayName: "Hermes Agent (Nous Research)",
  // Per agent/shell_hooks.py VALID_HOOKS plus the matchered tool
  // events. Users may put rules under any name; matchers only apply
  // to pre/post_tool_call.
  hookEvents: [
    "pre_tool_call",
    "post_tool_call",
    "pre_llm_call",
    "post_llm_call",
    "on_session_start",
    "on_session_end",
    "on_session_finalize",
    "on_session_reset",
    "subagent_stop",
    "pre_gateway_dispatch",
    "pre_approval_request",
    "post_approval_response",
    "transform_tool_result",
    "transform_terminal_output",
    "transform_llm_output",
  ],

  parseInput: parseClaudeStyleInput,

  async detect(_cwd, homeDir, fs) {
    const user = path.join(homeDir, ".hermes");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },

  settingsPath(cwd, homeDir, scope) {
    // Hermes only loads `~/.hermes/config.yaml` (single user-scoped
    // file). When `--scope project` is requested we still write a
    // project-local `.hermes/config.yaml` so users who symlink or
    // include it from their home config get a stable target. The
    // user-scope path is what hermes reads out of the box.
    return scope === "user"
      ? path.join(homeDir, ".hermes", "config.yaml")
      : path.join(cwd, ".hermes", "config.yaml");
  },

  async install(ctx) {
    return installHermesSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
    );
  },
};
