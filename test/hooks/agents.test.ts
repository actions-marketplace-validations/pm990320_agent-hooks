import { describe, expect, test } from "bun:test";
import { amp } from "../../src/hooks/amp/index.ts";
import { augmentCode } from "../../src/hooks/augment-code/index.ts";
import { claude } from "../../src/hooks/claude/handler.ts";
import { cline } from "../../src/hooks/cline/index.ts";
import { codebuddy } from "../../src/hooks/codebuddy/index.ts";
import { cortexCode } from "../../src/hooks/cortex-code/index.ts";
import { droid } from "../../src/hooks/droid/index.ts";
import { geminiCli } from "../../src/hooks/gemini-cli/index.ts";
import { githubCopilot } from "../../src/hooks/github-copilot/index.ts";
import { iflowCli } from "../../src/hooks/iflow-cli/index.ts";
import { kiloCode } from "../../src/hooks/kilo-code/index.ts";
import { kimiCodeCli } from "../../src/hooks/kimi-code-cli/index.ts";
import { kiro } from "../../src/hooks/kiro/index.ts";
import { kode } from "../../src/hooks/kode/index.ts";
import { neovate } from "../../src/hooks/neovate/index.ts";
import { opencode } from "../../src/hooks/opencode/index.ts";
import { openclaw } from "../../src/hooks/openclaw/index.ts";
import { pi } from "../../src/hooks/pi/index.ts";
import { qoder } from "../../src/hooks/qoder/index.ts";
import { qwenCode } from "../../src/hooks/qwen-code/index.ts";
import { windsurf } from "../../src/hooks/windsurf/index.ts";
import { runAgentSmokeTests } from "./shared.ts";

const CLAUDE_SAMPLE_JSON = JSON.stringify({
  hook_event_name: "PostToolUse",
  tool_name: "Edit",
  tool_input: { file_paths: ["src/a.ts"] },
});

const PLUGIN_SAMPLE_JSON = JSON.stringify({
  event: "PostToolUse",
  tool: "Edit",
  files: ["src/a.ts"],
});

describe("claude handler", () => {
  runAgentSmokeTests(claude, {
    configKey: "claude-code",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
    expectedToolName: "Edit",
  });
});

describe("gemini-cli handler", () => {
  runAgentSmokeTests(geminiCli, {
    configKey: "gemini-cli",
    sampleEvent: "BeforeTool",
    sampleInput: CLAUDE_SAMPLE_JSON,
    expectedToolName: "Edit",
  });
});

describe("droid handler", () => {
  runAgentSmokeTests(droid, {
    configKey: "droid",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("opencode handler", () => {
  runAgentSmokeTests(opencode, {
    configKey: "opencode",
    sampleEvent: "PostToolUse",
    sampleInput: PLUGIN_SAMPLE_JSON,
    expectedToolName: "Edit",
  });
});

describe("cline handler", () => {
  runAgentSmokeTests(cline, {
    configKey: "cline",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("windsurf handler", () => {
  runAgentSmokeTests(windsurf, {
    configKey: "windsurf",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("kiro handler", () => {
  runAgentSmokeTests(kiro, {
    configKey: "kiro",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("augment-code handler", () => {
  runAgentSmokeTests(augmentCode, {
    configKey: "augment-code",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("github-copilot handler", () => {
  runAgentSmokeTests(githubCopilot, {
    configKey: "github-copilot",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("amp handler", () => {
  runAgentSmokeTests(amp, {
    configKey: "amp",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("kilo-code handler", () => {
  runAgentSmokeTests(kiloCode, {
    configKey: "kilo-code",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("kode handler", () => {
  runAgentSmokeTests(kode, {
    configKey: "kode",
    sampleEvent: "PostToolUse",
    sampleInput: PLUGIN_SAMPLE_JSON,
  });
});

describe("qwen-code handler", () => {
  runAgentSmokeTests(qwenCode, {
    configKey: "qwen-code",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("kimi-code-cli handler", () => {
  runAgentSmokeTests(kimiCodeCli, {
    configKey: "kimi-code-cli",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("iflow-cli handler", () => {
  runAgentSmokeTests(iflowCli, {
    configKey: "iflow-cli",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("codebuddy handler", () => {
  runAgentSmokeTests(codebuddy, {
    configKey: "codebuddy",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("cortex-code handler", () => {
  runAgentSmokeTests(cortexCode, {
    configKey: "cortex-code",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("qoder handler", () => {
  runAgentSmokeTests(qoder, {
    configKey: "qoder",
    sampleEvent: "PostToolUse",
    sampleInput: CLAUDE_SAMPLE_JSON,
  });
});

describe("pi handler", () => {
  runAgentSmokeTests(pi, {
    configKey: "pi",
    sampleEvent: "PostToolUse",
    sampleInput: PLUGIN_SAMPLE_JSON,
  });
});

describe("neovate handler", () => {
  runAgentSmokeTests(neovate, {
    configKey: "neovate",
    sampleEvent: "PostToolUse",
    sampleInput: PLUGIN_SAMPLE_JSON,
  });
});

describe("openclaw handler", () => {
  runAgentSmokeTests(openclaw, {
    configKey: "openclaw",
    sampleEvent: "PostToolUse",
    sampleInput: PLUGIN_SAMPLE_JSON,
  });

  // openclaw's detect uses a `.openclaw` marker rather than the
  // settingsPath parent chain, so the shared test can't cover the
  // project-present branch.
  test("openclaw detect finds .openclaw marker under cwd", async () => {
    const files = new Map<string, string>([["/repo/.openclaw", ""]]);
    const memFs = {
      exists: (p: string) => Promise.resolve(files.has(p)),
      read: () => Promise.reject(new Error("unused")),
      write: () => Promise.resolve(),
      mkdirRecursive: () => Promise.resolve(),
    };
    const result = await openclaw.detect("/repo", "/home/t", memFs);
    expect(result.present).toBe(true);
    expect(result.scope).toBe("project");
  });
});
