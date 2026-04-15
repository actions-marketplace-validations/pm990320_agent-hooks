import { Readable } from "node:stream";
import { run } from "../../../src/cli.ts";

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunCliOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

/**
 * Invoke the agent-hooks CLI in-process by importing `run` from src/cli.ts
 * directly. Captures stdout/stderr by swapping `process.stdout.write` and
 * `process.stderr.write` for the duration of the call. Restores everything
 * in a `finally` so tests don't leak state even if an assertion throws.
 *
 * This is deliberately *not* a subprocess spawn. Running in-process is
 * faster, gives us real stack traces on failure, and — importantly — lets
 * us hold a consistent cwd since `process.chdir` only affects this pid.
 */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions,
): Promise<CliResult> {
  const originalCwd = process.cwd();
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalEnv: Record<string, string | undefined> = {};

  let stdout = "";
  let stderr = "";

  const captureOut = ((chunk: string | Uint8Array): boolean => {
    stdout +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  const captureErr = ((chunk: string | Uint8Array): boolean => {
    stderr +=
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;

  // If stdin is provided, temporarily swap process.stdin for a fake
  // Readable that emits the given string — the hook command's default
  // reader uses process.stdin, so this is how we feed hook payloads
  // without spawning a subprocess.
  let stdinRestore: (() => void) | null = null;
  if (options.stdin !== undefined) {
    const fake = Readable.from([options.stdin]);
    (fake as unknown as { isTTY: boolean }).isTTY = false;
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: fake,
      configurable: true,
      writable: false,
    });
    stdinRestore = () => {
      if (original) {
        Object.defineProperty(process, "stdin", original);
      }
    };
  }

  // Force buffered output mode for every spawned step so the in-process
  // capture below sees their stdout/stderr — `inherit` mode would write
  // straight to fd 1/2 and bypass process.stdout.write swapping.
  const previousForceMode = process.env["AGENT_HOOKS_FORCE_OUTPUT_MODE"];
  process.env["AGENT_HOOKS_FORCE_OUTPUT_MODE"] = "buffered";

  try {
    process.chdir(options.cwd);
    process.stdout.write = captureOut;
    process.stderr.write = captureErr;

    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        originalEnv[k] = process.env[k];
        process.env[k] = v;
      }
    }

    const exitCode = await run(argv);
    return { exitCode, stdout, stderr };
  } finally {
    if (previousForceMode === undefined) {
      delete process.env["AGENT_HOOKS_FORCE_OUTPUT_MODE"];
    } else {
      process.env["AGENT_HOOKS_FORCE_OUTPUT_MODE"] = previousForceMode;
    }
    process.chdir(originalCwd);
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    stdinRestore?.();
  }
}
