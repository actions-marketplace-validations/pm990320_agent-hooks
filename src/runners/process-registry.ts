/**
 * Process-wide registry of live child subprocesses, plus signal
 * handlers that propagate SIGINT/SIGTERM to them. Without this, hitting
 * Ctrl-C during `agent-hooks ci` exits the parent immediately and
 * leaves test runners, builders, and linters orphaned in the background.
 *
 * Usage from a spawner:
 *
 *   const dispose = registerChild(proc);
 *   try {
 *     // ... await proc.exited
 *   } finally {
 *     dispose();
 *   }
 *
 * The signal handler is installed once at process startup via
 * `installSignalHandlers()` from `src/index.ts`. Tests opt out by not
 * calling `installSignalHandlers()` and exercising the registry funcs
 * directly.
 */

/**
 * Subset of the child-process API we depend on. Both Bun's
 * `Bun.spawn` result and Node's `child_process.ChildProcess` satisfy
 * this — keeps the registry portable across spawners.
 */
export interface ChildHandle {
  kill(signal?: NodeJS.Signals | number): boolean | void;
}

const liveChildren = new Set<ChildHandle>();

/** Add a child to the registry. Returns a `dispose()` to remove it. */
export function registerChild(child: ChildHandle): () => void {
  liveChildren.add(child);
  return () => {
    liveChildren.delete(child);
  };
}

/** How many children are currently registered. Test-only. */
export function liveChildCount(): number {
  return liveChildren.size;
}

/**
 * Send `signal` to every registered child. Errors are swallowed —
 * a child that's already exited will reject `kill`, and that's fine.
 * Returns the number of children we attempted to signal.
 */
export function killAllChildren(
  signal: NodeJS.Signals = "SIGTERM",
): number {
  const count = liveChildren.size;
  for (const child of liveChildren) {
    try {
      child.kill(signal);
    } catch {
      // Already dead, or kill is not permitted — either way, nothing
      // to do. We removed the dead-child cleanup loop because it adds
      // complexity for no benefit; the next dispose() will clean up.
    }
  }
  return count;
}

/** Test-only: clear the registry without signaling. */
export function resetRegistryForTesting(): void {
  liveChildren.clear();
}

interface SignalHandlerOptions {
  /** Override `process.exit` so tests can assert on the exit code. */
  readonly exit?: (code: number) => never;
  /**
   * Inject `process.on` so the test harness can intercept handler
   * registration without actually subscribing to OS signals.
   */
  readonly onSignal?: (
    signal: NodeJS.Signals,
    handler: () => void,
  ) => void;
  /** Override the escalation timer (default 2000ms). */
  readonly escalationDelayMs?: number;
  /** Override setTimeout so tests can fast-forward. */
  readonly schedule?: (cb: () => void, ms: number) => unknown;
}

/**
 * Install SIGINT + SIGTERM handlers that propagate to live children.
 *
 * First signal: SIGTERM every child, give them up to `escalationDelayMs`
 * to clean up, then SIGKILL the survivors and exit 130.
 *
 * Second signal arrives before escalation: skip the wait, SIGKILL
 * immediately and exit. Lets a frustrated user double-tap Ctrl-C.
 *
 * If no children are live when the signal arrives, exit immediately.
 */
export function installSignalHandlers(
  options: SignalHandlerOptions = {},
): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onSignal =
    options.onSignal ??
    ((sig: NodeJS.Signals, handler: () => void) => {
      process.on(sig, handler);
    });
  const schedule =
    options.schedule ??
    ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const escalationDelayMs = options.escalationDelayMs ?? 2000;

  let phase: "idle" | "draining" = "idle";

  const handler = (): void => {
    if (phase === "draining") {
      // Second signal — escalate immediately.
      killAllChildren("SIGKILL");
      exit(130);
      return;
    }
    const count = killAllChildren("SIGTERM");
    if (count === 0) {
      exit(130);
      return;
    }
    phase = "draining";
    schedule(() => {
      killAllChildren("SIGKILL");
      exit(130);
    }, escalationDelayMs);
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    onSignal(sig, handler);
  }
}
