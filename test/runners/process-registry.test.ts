import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  installSignalHandlers,
  killAllChildren,
  liveChildCount,
  registerChild,
  resetRegistryForTesting,
  type ChildHandle,
} from "../../src/runners/process-registry.ts";

// The registry is a module-level singleton. Integration tests that
// ran before this file may have spawned child processes whose dispose
// callbacks didn't fire (aborted runs, killed sleeps, etc.), leaking
// entries into the global Set. Reset before AND after every test so
// this file's first assertion can't see pollution from earlier files.
beforeEach(() => {
  resetRegistryForTesting();
});

afterEach(() => {
  resetRegistryForTesting();
});

interface FakeChild extends ChildHandle {
  killed: NodeJS.Signals[];
}

function fakeChild(): FakeChild {
  const killed: NodeJS.Signals[] = [];
  return {
    killed,
    kill(signal?: NodeJS.Signals | number): boolean {
      if (typeof signal === "string") killed.push(signal);
      else if (signal === undefined) killed.push("SIGTERM");
      else killed.push(`SIG${String(signal)}` as NodeJS.Signals);
      return true;
    },
  };
}

describe("registerChild + dispose", () => {
  test("registers a child and reflects it in the count", () => {
    const child = fakeChild();
    expect(liveChildCount()).toBe(0);
    const dispose = registerChild(child);
    expect(liveChildCount()).toBe(1);
    dispose();
    expect(liveChildCount()).toBe(0);
  });

  test("dispose is idempotent", () => {
    const child = fakeChild();
    const dispose = registerChild(child);
    dispose();
    dispose();
    expect(liveChildCount()).toBe(0);
  });

  test("two children are tracked independently", () => {
    const a = fakeChild();
    const b = fakeChild();
    const disposeA = registerChild(a);
    registerChild(b);
    expect(liveChildCount()).toBe(2);
    disposeA();
    expect(liveChildCount()).toBe(1);
  });
});

describe("killAllChildren", () => {
  test("signals every registered child and returns the count", () => {
    const a = fakeChild();
    const b = fakeChild();
    registerChild(a);
    registerChild(b);
    const count = killAllChildren("SIGTERM");
    expect(count).toBe(2);
    expect(a.killed).toEqual(["SIGTERM"]);
    expect(b.killed).toEqual(["SIGTERM"]);
  });

  test("swallows kill errors from already-dead children", () => {
    const dead: ChildHandle = {
      kill() {
        throw new Error("ESRCH: no such process");
      },
    };
    registerChild(dead);
    expect(() => killAllChildren("SIGTERM")).not.toThrow();
  });

  test("default signal is SIGTERM", () => {
    const child = fakeChild();
    registerChild(child);
    killAllChildren();
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  test("returns 0 when no children are registered", () => {
    expect(killAllChildren()).toBe(0);
  });
});

describe("installSignalHandlers", () => {
  function captureHandlers(): {
    handlers: Map<NodeJS.Signals, () => void>;
    onSignal: (sig: NodeJS.Signals, h: () => void) => void;
  } {
    const handlers = new Map<NodeJS.Signals, () => void>();
    const onSignal = (sig: NodeJS.Signals, h: () => void): void => {
      handlers.set(sig, h);
    };
    return { handlers, onSignal };
  }

  test("registers handlers for SIGINT and SIGTERM", () => {
    const { handlers, onSignal } = captureHandlers();
    installSignalHandlers({
      onSignal,
      exit: () => {
        throw new Error("unreachable");
      },
    });
    expect(handlers.has("SIGINT")).toBe(true);
    expect(handlers.has("SIGTERM")).toBe(true);
  });

  test("first signal SIGTERMs all children, then SIGKILLs after delay, then exits 130", () => {
    const { handlers, onSignal } = captureHandlers();
    const state = { exited: null as number | null };
    const scheduled: { cb: () => void; ms: number }[] = [];

    const child = fakeChild();
    registerChild(child);

    installSignalHandlers({
      onSignal,
      exit: ((code: number) => {
        state.exited = code;
        // Don't actually exit during the test.
        throw new SignalExit();
      }) as unknown as (code: number) => never,
      schedule: (cb, ms) => {
        scheduled.push({ cb, ms });
        return 0;
      },
      escalationDelayMs: 1234,
    });

    // First signal: SIGTERM the child, schedule escalation, do NOT exit.
    handlers.get("SIGINT")!();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(1234);
    expect(state.exited).toBeNull();

    // Fast-forward the scheduled callback.
    try {
      scheduled[0]!.cb();
    } catch (err) {
      if (!(err instanceof SignalExit)) throw err;
    }
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(state.exited).toBe(130);
  });

  test("exits immediately when no children are registered", () => {
    const { handlers, onSignal } = captureHandlers();
    const state = { exited: null as number | null };
    installSignalHandlers({
      onSignal,
      exit: ((code: number) => {
        state.exited = code;
        throw new SignalExit();
      }) as unknown as (code: number) => never,
      schedule: () => 0,
    });
    try {
      handlers.get("SIGINT")!();
    } catch (err) {
      if (!(err instanceof SignalExit)) throw err;
    }
    expect(state.exited).toBe(130);
  });

  test("second signal escalates to SIGKILL immediately", () => {
    const { handlers, onSignal } = captureHandlers();
    const state = { exited: null as number | null };
    const scheduled: { cb: () => void; ms: number }[] = [];
    const child = fakeChild();
    registerChild(child);

    installSignalHandlers({
      onSignal,
      exit: ((code: number) => {
        state.exited = code;
        throw new SignalExit();
      }) as unknown as (code: number) => never,
      schedule: (cb, ms) => {
        scheduled.push({ cb, ms });
        return 0;
      },
    });

    // First signal: enters draining state but doesn't exit yet.
    handlers.get("SIGINT")!();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(state.exited).toBeNull();

    // Second signal arrives before the scheduled escalation: bypass the
    // wait, SIGKILL immediately, exit.
    try {
      handlers.get("SIGINT")!();
    } catch (err) {
      if (!(err instanceof SignalExit)) throw err;
    }
    expect(child.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(state.exited).toBe(130);
  });
});

// Custom error so we can break out of the test exit hook without
// taking down the test runner.
class SignalExit extends Error {}
