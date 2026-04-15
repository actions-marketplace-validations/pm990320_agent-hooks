import fs from "node:fs/promises";
import path from "node:path";
import { runCli, type CliResult } from "./cli.ts";

/**
 * "Agent harness" — tooling for integration tests that simulate a real
 * coding agent's lifecycle end-to-end.
 *
 * Why this exists: we can't actually spawn Claude Code, Gemini CLI,
 * Cline, etc. in CI — they need API keys, network access, and real
 * AI backends. But we can simulate the part of the agent that matters
 * to us: firing hooks with realistic input payloads and observing the
 * side effects.
 *
 * The harness gives agent-driven tests three things:
 *
 *   1. `sendPromptToFakeAgent()` — drive a prompt through a fake agent
 *      that writes a marker file per tool-use. Used to verify our hook
 *      setup against an agent-shaped workflow.
 *   2. `fireAgentHook()` — directly invoke `agent-hooks hook <agent>
 *      <event>` with a JSON payload on stdin. The smallest possible
 *      simulation — great for testing the dispatcher.
 *   3. `writeFakeAgentScript()` — produces a shell script that
 *      pretends to be the agent and fires hooks against its own
 *      workflow when invoked. Used by tests that want to round-trip
 *      through a real subprocess.
 */

// --- Direct hook invocation ---------------------------------------------

export interface FireHookOptions {
  readonly agent: string;
  readonly event: string;
  /** JSON payload to feed over stdin. */
  readonly stdin: string;
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

/**
 * Directly fire a single hook invocation. Mirrors how an agent's
 * stub script would call us after a tool use.
 */
export async function fireAgentHook(
  options: FireHookOptions,
): Promise<CliResult> {
  return runCli(["hook", options.agent, options.event], {
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdin: options.stdin,
  });
}

// --- Fake agent script generation ---------------------------------------

export interface FakeAgentScriptOptions {
  /** Where to write the script (will be chmod +x'd). */
  readonly path: string;
  /** Agent name to dispatch through — e.g. "claude", "gemini-cli". */
  readonly agent: string;
  /** Which hook event to fire. */
  readonly event: string;
  /**
   * Optional marker file path. The script touches this after firing
   * its hook so tests can verify the agent itself "ran" independently
   * of the hook side effects.
   */
  readonly markerPath?: string;
}

/**
 * Write a POSIX shell script that simulates an agent firing one hook
 * invocation. When executed with `<marker-file> <file1> [file2] ...`,
 * the script:
 *
 *   1. Writes the marker file to prove the agent itself ran.
 *   2. Builds a Claude-style JSON payload referencing the files.
 *   3. Pipes that payload into `agent-hooks hook <agent> <event>`.
 *   4. Propagates agent-hooks' exit code — letting the test assert
 *      whether the hook dispatch would have blocked the tool use.
 */
export async function writeFakeAgentScript(
  options: FakeAgentScriptOptions,
): Promise<string> {
  // We build a JSON string in the shell rather than invoking jq/node
  // so the script runs with nothing but /bin/sh.
  const script = `#!/bin/sh
# fake ${options.agent} agent — integration test harness
set -eu
MARKER="\${1:-${options.markerPath ?? "/tmp/fake-agent-marker"}}"
shift 2>/dev/null || true

echo "fake-agent: ${options.agent} firing ${options.event}" > "$MARKER"

build_files() {
  first=1
  printf '['
  for f in "$@"; do
    if [ "$first" -eq 1 ]; then
      first=0
    else
      printf ','
    fi
    # Escape backslashes and double quotes for JSON.
    esc=$(printf '%s' "$f" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    printf '"%s"' "$esc"
  done
  printf ']'
}

FILES_JSON=$(build_files "$@")
PAYLOAD=$(printf '{"hook_event_name":"${options.event}","tool_name":"Edit","tool_input":{"file_paths":%s}}' "$FILES_JSON")

printf '%s' "$PAYLOAD" | agent-hooks hook ${options.agent} ${options.event}
`;

  await fs.mkdir(path.dirname(options.path), { recursive: true });
  await fs.writeFile(options.path, script, "utf8");
  await fs.chmod(options.path, 0o755);
  return options.path;
}

// --- Prompt-driven agent simulation -------------------------------------

export interface FakeAgentSession {
  /** Files the "agent" is going to edit during this session. */
  readonly files: readonly string[];
  /** Which hook event to fire for the edits. */
  readonly event: string;
  /** Agent to dispatch through. */
  readonly agent: string;
}

export interface SendPromptOptions {
  readonly prompt: string;
  readonly session: FakeAgentSession;
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

export interface SendPromptResult {
  readonly promptEcho: string;
  readonly hookResult: CliResult;
  /**
   * Marker file written by the fake agent — exists after the run so
   * tests can assert the agent "saw" the prompt.
   */
  readonly markerPath: string;
}

/**
 * Drive a prompt through a fake agent. The harness:
 *
 *   1. Writes a marker file describing the prompt (simulates the agent
 *      receiving + processing the prompt).
 *   2. Fires the configured hook event via `agent-hooks hook <agent>
 *      <event>` with the session's files.
 *   3. Returns both the marker path and the hook invocation result so
 *      tests can verify the agent was "invoked" and that our hooks
 *      dispatched correctly.
 *
 * Use this when you want a test that reads "given a prompt, the
 * agent did X and our hook fired with Y". The prompt itself is
 * recorded but not interpreted — no real LLM is called.
 */
export async function sendPromptToFakeAgent(
  options: SendPromptOptions,
): Promise<SendPromptResult> {
  const markerPath = path.join(options.cwd, ".fake-agent-marker");
  await fs.writeFile(
    markerPath,
    `prompt: ${options.prompt}\nfiles: ${options.session.files.join(", ")}\n`,
    "utf8",
  );

  const payload = JSON.stringify({
    hook_event_name: options.session.event,
    tool_name: "Edit",
    tool_input: {
      file_paths: [...options.session.files],
    },
  });

  const hookResult = await fireAgentHook({
    agent: options.session.agent,
    event: options.session.event,
    stdin: payload,
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
  });

  return {
    promptEcho: options.prompt,
    hookResult,
    markerPath,
  };
}
