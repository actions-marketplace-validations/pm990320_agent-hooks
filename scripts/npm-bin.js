#!/usr/bin/env node
// agent-hooks npm bin wrapper
//
// Locates the native binary downloaded by the postinstall and execs
// it with the current process's argv, stdio, and signal handling.
// Forwards the exit code. Also handles the `--ignore-scripts` case
// (binary missing) with a clear error message.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

function resolveBinaryPath() {
  // Respect an explicit override — handy for testing, vendored mirrors,
  // or developer workflows where the caller wants to point at a local
  // build instead of the download.
  if (process.env.AGENT_HOOKS_BINARY) {
    return process.env.AGENT_HOOKS_BINARY;
  }

  const ext = os.platform() === "win32" ? ".exe" : "";
  return path.join(PKG_ROOT, "bin", `agent-hooks${ext}`);
}

function diePostinstallMissing(binPath) {
  process.stderr.write(
    `agent-hooks: native binary not found at ${binPath}\n\n` +
      `This usually means npm was run with --ignore-scripts, or the\n` +
      `postinstall download was blocked. To recover:\n\n` +
      `  1. Re-run npm install without --ignore-scripts, or\n` +
      `  2. Fetch the matching binary manually from\n` +
      `     https://github.com/pm990320/agent-hooks/releases and set\n` +
      `     AGENT_HOOKS_BINARY=/path/to/agent-hooks before invocation.\n`,
  );
  process.exit(127);
}

function main() {
  const binary = resolveBinaryPath();

  if (!existsSync(binary)) {
    diePostinstallMissing(binary);
  }

  // Use spawn with stdio: "inherit" so the child sees the real TTY
  // (important for agent-hooks commands that read stdin, like
  // interactive init confirmations, and for preserving the native
  // binary's output ANSI). argv.slice(2) skips [node, this-script].
  const child = spawn(binary, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: false,
  });

  // Forward POSIX termination signals so Ctrl-C cleanly kills the
  // native process. Without this, SIGINT goes to Node only and the
  // native binary is orphaned briefly.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      // Translate the signal into the conventional 128+signum exit
      // code so shells / CI systems see a useful number rather than
      // null. Node's os.constants.signals has the numeric mapping.
      const signum = os.constants.signals[signal];
      if (typeof signum === "number") {
        process.exit(128 + signum);
      }
      process.exit(1);
    }
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    process.stderr.write(
      `agent-hooks: failed to spawn ${binary}: ${err.message}\n`,
    );
    process.exit(1);
  });
}

main();
