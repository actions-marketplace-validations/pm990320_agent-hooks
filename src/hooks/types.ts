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
