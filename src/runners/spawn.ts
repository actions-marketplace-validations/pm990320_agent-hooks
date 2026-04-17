/**
 * Portable process spawner that works under both Bun and Node.js.
 *
 * Bun.spawn returns a different handle shape than child_process.spawn:
 * - `.exited` (Promise<number>) vs `.on("exit", fn)`
 * - Web ReadableStream on `.stdout`/`.stderr` vs Node Readable
 *
 * This module wraps child_process.spawn into the shape the rest of
 * agent-hooks expects, so we can compile with --target=node for npm
 * distribution without touching every consumer. The same code also
 * works under Bun (child_process is Bun-compatible).
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { text } from "node:stream/consumers";

export interface SpawnOptions {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "pipe" | "inherit";
  readonly stdout?: "pipe" | "inherit";
  readonly stderr?: "pipe" | "inherit";
}

export interface SpawnHandle {
  /** Resolves with the exit code once the child terminates. */
  readonly exited: Promise<number>;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly pid: number | undefined;
}

export function spawnProcess(options: SpawnOptions): SpawnHandle {
  const [cmd = "sh", ...args] = options.cmd;
  const child: ChildProcess = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: [
      options.stdin ?? "inherit",
      options.stdout ?? "inherit",
      options.stderr ?? "inherit",
    ],
  });

  const exited = new Promise<number>((resolve, reject) => {
    child.on("exit", (code: number | null) => {
      resolve(code ?? 1);
    });
    child.on("error", (err: Error) => {
      reject(err);
    });
  });

  return {
    exited,
    stdout: child.stdout ?? null,
    stderr: child.stderr ?? null,
    stdin: child.stdin ?? null,
    kill(signal?: NodeJS.Signals | number): boolean {
      if (typeof signal === "number") {
        return child.kill(signal);
      }
      return child.kill(signal);
    },
    pid: child.pid,
  };
}

/**
 * Read a Readable stream fully to a UTF-8 string. Works on Node
 * Readable (from child_process.spawn) and Web ReadableStream
 * (from Bun.spawn).
 */
export async function streamToText(
  stream: Readable | ReadableStream | null,
): Promise<string> {
  if (!stream) return "";
  // Node Readable — has .on() method
  if ("on" in stream && typeof stream.on === "function") {
    return text(stream);
  }
  // Web ReadableStream — Bun path
  return new Response(stream as ReadableStream).text();
}
