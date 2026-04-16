import type { Config } from "../config/schema.ts";

/**
 * Normalized input shape every agent hook handler produces from its
 * native payload. Tool name, files, and event name are enough to
 * resolve which pipeline to run; `extra` keeps raw fields around for
 * handlers that want richer access.
 */
export interface NormalizedHookInput {
  readonly toolName: string | null;
  readonly files: readonly string[];
  readonly hookEventName: string | null;
  readonly sessionId?: string | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Filesystem surface needed by agent detection + install. */
export interface AgentFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string): Promise<void>;
  mkdirRecursive(p: string): Promise<void>;
}

export type AgentInstallScope = "project" | "user";

export interface AgentDetection {
  readonly present: boolean;
  readonly scope?: AgentInstallScope | undefined;
  readonly path?: string | undefined;
}

export interface AgentInstallContext {
  readonly config: Config;
  readonly cwd: string;
  readonly homeDir: string;
  readonly scope: AgentInstallScope;
  readonly fs: AgentFs;
}

export interface AgentInstallResult {
  readonly path: string;
  readonly action: "created" | "merged" | "unchanged";
}

/**
 * Declarative handler describing how to parse, detect, and install one
 * coding agent's hook system. Each entry is registered in
 * `src/hooks/registry.ts` and picked up by the dispatcher + installer.
 */
export interface AgentHandler {
  readonly name: string;
  readonly displayName: string;
  readonly hookEvents: readonly string[];

  /**
   * Whether this agent treats hook exit code 2 as "non-blocking
   * feedback" — i.e., stderr is fed back to the model so it can
   * self-correct — and any OTHER non-zero exit code as a user-visible
   * error that bypasses the model entirely. When `true`, the hook
   * dispatcher remaps any pipeline failure to exit 2 so our
   * `---agent-hooks:next-step---` stderr blocks reach the coding
   * agent instead of silently stopping at the user's terminal.
   *
   * Only set to `true` for agents where this contract has been
   * verified against the agent's official documentation. Agents that
   * merely share Claude Code's settings.json shape do NOT necessarily
   * share its exit-code semantics — some may treat exit 2 as "halt
   * the session" or ignore it entirely. Default (undefined) means
   * pass the pipeline's exit code through verbatim, which is always
   * safe (the agent may or may not show it to the model, but we
   * haven't made the situation worse).
   *
   * Confirmed-supporting agents as of 2026-04: claude, codex.
   */
  readonly stderrFeedbackOnExit2?: boolean;

  /** Parse raw stdin text into the normalized shape. */
  parseInput(raw: string): NormalizedHookInput;

  /** Locate an existing install of this agent. */
  detect(cwd: string, homeDir: string, fs: AgentFs): Promise<AgentDetection>;

  /** Compute where the native settings file lives. */
  settingsPath(cwd: string, homeDir: string, scope: AgentInstallScope): string;

  /**
   * Produce the native settings contents to write. May merge with an
   * existing parsed settings object (or `null` when no prior file).
   */
  install(ctx: AgentInstallContext): Promise<AgentInstallResult>;
}
