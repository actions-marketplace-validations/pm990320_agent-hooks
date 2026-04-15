import { amp } from "./amp/index.ts";
import { augmentCode } from "./augment-code/index.ts";
import { claude } from "./claude/handler.ts";
import { cline } from "./cline/index.ts";
import { codebuddy } from "./codebuddy/index.ts";
import { cortexCode } from "./cortex-code/index.ts";
import { droid } from "./droid/index.ts";
import { geminiCli } from "./gemini-cli/index.ts";
import { githubCopilot } from "./github-copilot/index.ts";
import { iflowCli } from "./iflow-cli/index.ts";
import { kiloCode } from "./kilo-code/index.ts";
import { kimiCodeCli } from "./kimi-code-cli/index.ts";
import { kiro } from "./kiro/index.ts";
import { kode } from "./kode/index.ts";
import { neovate } from "./neovate/index.ts";
import { opencode } from "./opencode/index.ts";
import { openclaw } from "./openclaw/index.ts";
import { pi } from "./pi/index.ts";
import { qoder } from "./qoder/index.ts";
import { qwenCode } from "./qwen-code/index.ts";
import type { AgentHandler } from "./types.ts";
import { windsurf } from "./windsurf/index.ts";

/**
 * Canonical list of agent handlers. Order here is the order used for
 * `agent-hooks agent list` and `agent-hooks doctor` output.
 */
export const AGENT_HANDLERS: readonly AgentHandler[] = [
  claude,
  geminiCli,
  opencode,
  cline,
  droid,
  windsurf,
  kiro,
  augmentCode,
  githubCopilot,
  amp,
  kiloCode,
  kode,
  qwenCode,
  kimiCodeCli,
  iflowCli,
  codebuddy,
  cortexCode,
  qoder,
  pi,
  neovate,
  openclaw,
];

export function getAgentHandler(name: string): AgentHandler | null {
  return AGENT_HANDLERS.find((h) => h.name === name) ?? null;
}

export function listAgentNames(): readonly string[] {
  return AGENT_HANDLERS.map((h) => h.name);
}
