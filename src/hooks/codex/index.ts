import path from "node:path";
import { parseClaudeStyleInput } from "../parsers.ts";
import { installClaudeStyleSettings } from "../settings-writers.ts";
import type { AgentHandler, AgentInstallContext } from "../types.ts";

/**
 * OpenAI Codex CLI. Uses Claude-Code-style JSON on stdin
 * (hook_event_name + tool_name + tool_input + session_id). As of
 * early 2026 Codex's PostToolUse emits only for the Bash tool (no
 * file-editing hook yet — tracked upstream), and its tool_input
 * carries `command` rather than `file_path`. That means this handler
 * extracts no files from PostToolUse payloads, so project-scoped
 * pipeline steps (typically what `agent-edit` contains) are the
 * right fit — per-file pipelines will have nothing to narrow on.
 *
 * Hooks config lives at `.codex/hooks.json` (project) or
 * `~/.codex/hooks.json` (user); Codex merges both. The hook system
 * is gated behind `[features] codex_hooks = true` in
 * `.codex/config.toml` / `~/.codex/config.toml`, so install writes
 * that flag alongside hooks.json.
 *
 * Ref: https://developers.openai.com/codex/hooks
 */
export const codex: AgentHandler = {
  name: "codex",
  displayName: "Codex (OpenAI)",
  // Per https://developers.openai.com/codex/hooks — the full event
  // surface as of early 2026. Codex may extend this (file-editing
  // hooks are tracked upstream); users can put rules under any event
  // name in their agent-hooks config.
  hookEvents: [
    "SessionStart",
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "Stop",
  ],

  // Verified: Codex treats exit 2 as non-blocking feedback — stderr
  // is appended to the conversation for the model to self-correct,
  // matching Claude Code's convention. Other non-zero codes are
  // user-visible only. Source: developers.openai.com/codex/hooks.
  stderrFeedbackOnExit2: true,

  parseInput: parseClaudeStyleInput,

  async detect(cwd, homeDir, fs) {
    const project = path.join(cwd, ".codex");
    if (await fs.exists(project)) {
      return { present: true, scope: "project", path: project };
    }
    const user = path.join(homeDir, ".codex");
    if (await fs.exists(user)) {
      return { present: true, scope: "user", path: user };
    }
    return { present: false };
  },

  settingsPath(cwd, homeDir, scope) {
    return scope === "user"
      ? path.join(homeDir, ".codex", "hooks.json")
      : path.join(cwd, ".codex", "hooks.json");
  },

  async install(ctx) {
    const hooksResult = await installClaudeStyleSettings(
      ctx,
      this.settingsPath(ctx.cwd, ctx.homeDir, ctx.scope),
      "codex",
      "codex",
    );

    // Codex gates hook dispatch behind a feature flag. Splice
    // `[features] codex_hooks = true` into the scope's config.toml
    // whenever codex hooks are actually configured — otherwise
    // hooks.json exists but Codex ignores it. Gated on the user
    // having rules under `agents.codex`, not on whether hooks.json
    // needed rewriting, so a stale config.toml without the flag
    // gets repaired even when hooks.json is already current.
    const codexRules = ctx.config.agents?.codex?.hooks;
    if (codexRules && Object.keys(codexRules).length > 0) {
      const configTomlPath =
        ctx.scope === "user"
          ? path.join(ctx.homeDir, ".codex", "config.toml")
          : path.join(ctx.cwd, ".codex", "config.toml");
      await ensureCodexFeatureFlag(ctx, configTomlPath);
    }

    return hooksResult;
  },
};

/**
 * Ensure `[features] codex_hooks = true` is present in the target
 * config.toml. This does minimal text splicing rather than full TOML
 * parsing: (1) no-op if the flag already appears anywhere, (2) insert
 * the flag right after an existing `[features]` header if present,
 * (3) else append a fresh `[features]` section at the end, (4) else
 * create the file with just that section.
 *
 * Full TOML parse/rewrite would preserve comments and key ordering
 * perfectly, but it's not worth a TOML-library dep for this one flag.
 * The splice handles every realistic Codex config.toml shape.
 */
async function ensureCodexFeatureFlag(
  ctx: AgentInstallContext,
  tomlPath: string,
): Promise<void> {
  const flagLine = "codex_hooks = true";

  if (!(await ctx.fs.exists(tomlPath))) {
    await ctx.fs.mkdirRecursive(path.dirname(tomlPath));
    await ctx.fs.write(tomlPath, `[features]\n${flagLine}\n`);
    return;
  }

  const existing = await ctx.fs.read(tomlPath);
  // Already set? Match a line starting with `codex_hooks = true`,
  // tolerating leading whitespace and inline comments.
  if (/(^|\n)\s*codex_hooks\s*=\s*true(\s|#|$)/.test(existing)) {
    return;
  }

  // Has a `[features]` section already? Insert our flag right after
  // the header line. Matches a line that's exactly `[features]` (with
  // optional trailing whitespace) — does NOT match `[features.sub]`.
  const featuresMatch = /(^|\n)\[features\][ \t]*(\n|$)/.exec(existing);
  if (featuresMatch?.index !== undefined) {
    const insertPos = featuresMatch.index + featuresMatch[0].length;
    const next =
      existing.slice(0, insertPos) + `${flagLine}\n` + existing.slice(insertPos);
    await ctx.fs.write(tomlPath, next);
    return;
  }

  // Append a fresh section.
  const separator = existing.endsWith("\n") ? "" : "\n";
  await ctx.fs.write(tomlPath, `${existing}${separator}\n[features]\n${flagLine}\n`);
}
