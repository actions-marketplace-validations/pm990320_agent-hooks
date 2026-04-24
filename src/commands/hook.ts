import type { Command } from "commander";
import { ExitError } from "../cli.ts";
import { ConfigError, ConfigNotFoundError } from "../config/errors.ts";
import type { LoadedConfig } from "../config/load.ts";
import {
  type LoadedProject,
  type LoadedWorkspaceConfig,
} from "../config/project.ts";
import { dispatchAgentHook } from "../hooks/dispatch.ts";
import { dispatchGitHook, scopeForGitHook } from "../hooks/git/dispatch.ts";
import { getAgentHandler } from "../hooks/registry.ts";
import { pickReporter } from "../reporters/index.ts";
import { resolveFiles, type GitRunner, type Scope } from "../runners/files.ts";
import { routeRepoFiles } from "../runners/workspace-paths.ts";
import { defaultRunDeps, type RunCommandDeps } from "./run.ts";

export interface HookCommandDeps
  extends Pick<
    RunCommandDeps,
    | "cwd"
    | "write"
    | "writeErr"
    | "load"
    | "loadProject"
    | "makeGit"
    | "exec"
    | "env"
  > {
  readonly readStdin: () => Promise<string>;
}

/**
 * Input for readStdinStream — a Readable-like object with `isTTY` and
 * event subscription. Accepting a parameter keeps the logic testable
 * without mocking `process.stdin`.
 */
export interface ReadableLike {
  readonly isTTY?: boolean | undefined;
  on(
    event: "data" | "end" | "error",
    cb: (arg?: unknown) => void,
  ): ReadableLike;
}

/**
 * Default upper bound on stdin payloads (16 MB). Real Claude Code /
 * Codex / Cursor hook payloads are well under 100 KB; this exists to
 * shed a buggy or malicious agent that streams indefinitely. Caller
 * can override via the second argument when bigger inputs are
 * legitimate.
 */
export const DEFAULT_STDIN_MAX_BYTES = 16 * 1024 * 1024;

export class StdinTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(
      `stdin exceeded the ${String(maxBytes)}-byte hook input cap. ` +
        `Set AGENT_HOOKS_STDIN_MAX to raise it if your agent legitimately ` +
        `sends larger payloads.`,
    );
    this.name = "StdinTooLargeError";
  }
}

/** Thrown when stdin contains bytes that aren't valid UTF-8. */
export class StdinNotUtf8Error extends Error {
  constructor() {
    super(
      "hook input contained invalid UTF-8 bytes. agent-hooks expects " +
        "JSON or text on stdin from agents — re-encode the upstream payload.",
    );
    this.name = "StdinNotUtf8Error";
  }
}

/**
 * Read stdin (a Readable-like) into a UTF-8 string.
 *
 * Contract: the result is decoded with `fatal: true`, so any byte
 * sequence that isn't valid UTF-8 throws `StdinNotUtf8Error` instead
 * of being silently replaced with U+FFFD. Hook payloads from every
 * supported agent are UTF-8 JSON, so anything else is almost
 * certainly a bug upstream — we'd rather fail loud than corrupt the
 * file paths inside.
 */
export function readStdinStream(
  stream: ReadableLike,
  maxBytes: number = DEFAULT_STDIN_MAX_BYTES,
): Promise<string> {
  if (stream.isTTY) return Promise.resolve("");
  const chunks: Buffer[] = [];
  let total = 0;
  return new Promise((resolve, reject) => {
    stream
      .on("data", (chunk: unknown) => {
        let buf: Buffer | null = null;
        if (chunk instanceof Buffer) buf = chunk;
        else if (typeof chunk === "string") buf = Buffer.from(chunk);
        if (!buf) return;
        total += buf.length;
        if (total > maxBytes) {
          reject(new StdinTooLargeError(maxBytes));
          return;
        }
        chunks.push(buf);
      })
      .on("end", () => {
        const merged = Buffer.concat(chunks);
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            merged,
          );
          resolve(text);
        } catch {
          reject(new StdinNotUtf8Error());
        }
      })
      .on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
  });
}

async function loadOrReport(
  deps: HookCommandDeps,
): Promise<LoadedConfig | number> {
  try {
    return await deps.load(deps.cwd);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ConfigNotFoundError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }
}

async function loadProjectOrReport(
  deps: HookCommandDeps,
): Promise<LoadedProject | number> {
  try {
    if (deps.loadProject) {
      return await deps.loadProject(deps.cwd);
    }
    return { mode: "single", loaded: await deps.load(deps.cwd) };
  } catch (err) {
    if (err instanceof ConfigError || err instanceof ConfigNotFoundError) {
      deps.writeErr(`✗ ${err.message}\n`);
      if (err.details) deps.writeErr(`${err.details}\n`);
      return 2;
    }
    throw err;
  }
}

function rebaseGitRunner(
  git: GitRunner,
  workspace: Pick<LoadedWorkspaceConfig, "relativePath" | "workspaceRoot">,
): GitRunner {
  function rebase(files: readonly string[]): readonly string[] {
    return files
      .filter(
        (file) =>
          file === workspace.relativePath ||
          file.startsWith(`${workspace.relativePath}/`),
      )
      .map((file) =>
        file === workspace.relativePath
          ? "."
          : file.slice(workspace.relativePath.length + 1),
      );
  }

  return {
    staged: async () => rebase(await git.staged()),
    changed: async (baseRef?: string) => rebase(await git.changed(baseRef)),
    all: async () => rebase(await git.all()),
    ...(git.gitRoot
      ? { gitRoot: () => Promise.resolve(workspace.workspaceRoot) }
      : {}),
    ...(git.commitMessage
      ? {
          commitMessage: () => {
            if (!git.commitMessage) return Promise.resolve(null);
            return git.commitMessage();
          },
        }
      : {}),
    ...(git.modifiedUnder
      ? {
          modifiedUnder: async (subPath: string) => {
            const target =
              subPath === "." || subPath.length === 0
                ? workspace.relativePath
                : `${workspace.relativePath}/${subPath}`.replaceAll("//", "/");
            if (!git.modifiedUnder) return [];
            return rebase(await git.modifiedUnder(target));
          },
        }
      : {}),
    ...(git.stage
      ? {
          stage: async (paths: readonly string[]) => {
            const repoPaths = paths.map((file) =>
              file === "." || file.length === 0
                ? workspace.relativePath
                : `${workspace.relativePath}/${file}`.replaceAll("//", "/"),
            );
            if (!git.stage) return;
            await git.stage(repoPaths);
          },
        }
      : {}),
  };
}

function agentRulesExist(
  loaded: LoadedConfig,
  agentKey: string,
  hookName: string,
): boolean {
  const rules = loaded.config.agents?.[agentKey]?.hooks?.[hookName];
  return Array.isArray(rules) && rules.length > 0;
}

function gitRuleScope(loaded: LoadedConfig, hookName: string): Scope | null {
  const rule = loaded.config.git?.hooks?.[hookName];
  if (!rule) return null;
  return rule.scope ?? scopeForGitHook(hookName);
}

async function runGit(
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  const project = await loadProjectOrReport(deps);
  if (typeof project === "number") return project;

  if (project.mode === "single") {
    const reporter = pickReporter({ env: deps.env, write: deps.write });
    const result = await dispatchGitHook({
      hookName,
      config: project.loaded.config,
      cwd: deps.cwd,
      repoRoot: deps.cwd,
      env: deps.env,
      git: deps.makeGit(deps.cwd),
      exec: deps.exec,
      reporter,
      write: deps.write,
    });

    if (result.status === "no-rule") return 0;
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ git hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    return result.exitCode;
  }

  for (const warning of project.warnings) {
    deps.write(`  ⚠ ${warning}\n`);
  }

  const git = deps.makeGit(project.repoRoot);
  const candidates: { loaded: LoadedConfig; scope: Scope }[] = [];
  const rootScope = gitRuleScope(project.root, hookName);
  if (rootScope) candidates.push({ loaded: project.root, scope: rootScope });
  for (const workspace of project.workspaces) {
    const scope = gitRuleScope(workspace, hookName);
    if (scope) candidates.push({ loaded: workspace, scope });
  }
  if (candidates.length === 0) return 0;

  const filesByScope = new Map<Scope, readonly string[]>();
  for (const candidate of candidates) {
    if (filesByScope.has(candidate.scope)) continue;
    const resolved = await resolveFiles(git, { scope: candidate.scope });
    filesByScope.set(candidate.scope, resolved.files);
  }

  let finalCode = 0;
  let sawAny = false;
  const rootReporter = pickReporter({ env: deps.env, write: deps.write });
  if (rootScope) {
    const result = await dispatchGitHook({
      hookName,
      config: project.root.config,
      cwd: project.repoRoot,
      repoRoot: project.repoRoot,
      env: deps.env,
      git,
      resolvedFiles: filesByScope.get(rootScope) ?? [],
      exec: deps.exec,
      reporter: rootReporter,
      write: deps.write,
    });
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ git hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    if (result.status === "ran") {
      sawAny = true;
      if (finalCode === 0) finalCode = result.exitCode;
    }
  }

  for (const workspace of project.workspaces) {
    const scope = gitRuleScope(workspace, hookName);
    if (!scope) continue;
    const routed = routeRepoFiles(filesByScope.get(scope) ?? [], [workspace]);
    const workspaceFiles = routed.workspaces[0]?.workspaceFiles ?? [];
    const result = await dispatchGitHook({
      hookName,
      config: workspace.config,
      cwd: workspace.workspaceRoot,
      repoRoot: project.repoRoot,
      env: deps.env,
      git: rebaseGitRunner(git, workspace),
      resolvedFiles: workspaceFiles,
      exec: deps.exec,
      reporter: pickReporter({ env: deps.env, write: deps.write }),
      write: deps.write,
    });
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ git hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    if (result.status === "ran") {
      sawAny = true;
      if (finalCode === 0) finalCode = result.exitCode;
    }
  }

  return sawAny ? finalCode : 0;
}

/**
 * The agent key stored in `config.agents.*` doesn't always match the
 * CLI agent name 1:1 (Claude Code uses "claude-code" in config but
 * "claude" on the command line). This table handles that mapping so
 * users can keep writing `hooks: { PostToolUse: [...] }` under
 * `agents.claude-code.hooks` while the CLI stays terse.
 */
const AGENT_CONFIG_KEY_OVERRIDES: Record<string, string> = {
  claude: "claude-code",
};

function configKeyFor(agentName: string): string {
  return AGENT_CONFIG_KEY_OVERRIDES[agentName] ?? agentName;
}

async function runRegisteredAgent(
  agentName: string,
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  const handler = getAgentHandler(agentName);
  if (!handler) {
    deps.writeErr(
      `✗ unknown hook agent: "${agentName}"\n` +
        `  known: git, ${[...new Set(["claude", agentName])].join(", ")}…\n` +
        `  (try 'agent-hooks agent list' for the full set)\n`,
    );
    return 2;
  }

  const project = await loadProjectOrReport(deps);
  if (typeof project === "number") return project;

  const stdin = await deps.readStdin();
  const input = handler.parseInput(stdin);
  const agentKey = configKeyFor(agentName);

  if (project.mode === "single") {
    const reporter = pickReporter({ env: deps.env, write: deps.write });
    const result = await dispatchAgentHook({
      agentKey,
      hookName,
      input,
      config: project.loaded.config,
      cwd: deps.cwd,
      repoRoot: deps.cwd,
      env: deps.env,
      git: deps.makeGit(deps.cwd),
      exec: deps.exec,
      reporter,
    });

    if (result.status === "no-rule" || result.status === "no-matcher-match") {
      const reason =
        result.status === "no-rule"
          ? "no rule configured for this event"
          : `no matcher matched tool "${input.toolName ?? "(none)"}"`;
      deps.writeErr(`  ${agentName}/${hookName}: ${reason}\n`);
      if (deps.env.AGENT_HOOKS_DEBUG === "1") {
        const rules =
          project.loaded.config.agents?.[agentKey]?.hooks?.[hookName] ?? [];
        deps.writeErr(
          `  (configured rules: ${String(rules.length)}; tool: ${
            input.toolName ?? "(none)"
          })\n`,
        );
      }
      return 0;
    }
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ ${agentName} hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    return handler.stderrFeedbackOnExit2 && result.exitCode !== 0
      ? 2
      : result.exitCode;
  }

  for (const warning of project.warnings) {
    deps.write(`  ⚠ ${warning}\n`);
  }

  const git = deps.makeGit(project.repoRoot);
  const repoFiles =
    input.files.length > 0
      ? input.files
      : (await resolveFiles(git, { scope: "changed" })).files;
  const routed = routeRepoFiles(repoFiles, project.workspaces);

  let sawAny = false;
  let finalCode = 0;

  if (agentRulesExist(project.root, agentKey, hookName)) {
    const result = await dispatchAgentHook({
      agentKey,
      hookName,
      input,
      config: project.root.config,
      cwd: project.repoRoot,
      repoRoot: project.repoRoot,
      env: deps.env,
      git,
      resolvedFiles: routed.rootFiles,
      exec: deps.exec,
      reporter: pickReporter({ env: deps.env, write: deps.write }),
    });
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ ${agentName} hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    if (result.status === "ran") {
      sawAny = true;
      if (finalCode === 0) finalCode = result.exitCode;
    }
  }

  for (const routedWorkspace of routed.workspaces) {
    if (!agentRulesExist(routedWorkspace.workspace, agentKey, hookName)) continue;
    const result = await dispatchAgentHook({
      agentKey,
      hookName,
      input,
      config: routedWorkspace.workspace.config,
      cwd: routedWorkspace.workspace.workspaceRoot,
      repoRoot: project.repoRoot,
      env: deps.env,
      git: rebaseGitRunner(git, routedWorkspace.workspace),
      resolvedFiles: routedWorkspace.workspaceFiles,
      exec: deps.exec,
      reporter: pickReporter({ env: deps.env, write: deps.write }),
    });
    if (result.status === "pipeline-missing") {
      deps.writeErr(`✗ ${agentName} hook "${hookName}" references undefined pipeline\n`);
      return 2;
    }
    if (result.status === "ran") {
      sawAny = true;
      if (finalCode === 0) finalCode = result.exitCode;
    }
  }

  if (!sawAny) {
    deps.writeErr(`  ${agentName}/${hookName}: no rule configured for this event\n`);
    return 0;
  }

  return handler.stderrFeedbackOnExit2 && finalCode !== 0 ? 2 : finalCode;
}

export async function runHookCommand(
  agent: string,
  hookName: string,
  deps: HookCommandDeps,
): Promise<number> {
  if (agent === "git") return runGit(hookName, deps);
  return runRegisteredAgent(agent, hookName, deps);
}

/**
 * Implement `agent-hooks hook <agent> --list`: enumerate every hook
 * event the handler supports and mark the ones that have at least one
 * rule configured in `.config/agent-hooks.yml` under
 * `agents.<key>.hooks.<event>`. Also lists each rule's matcher +
 * pipeline so users can see what will fire without shelling in and
 * grepping the config themselves.
 *
 * Exits 0 on success, 2 on unknown-agent or config-load failure.
 */
export async function runHookListCommand(
  agent: string,
  deps: HookCommandDeps,
): Promise<number> {
  if (agent === "git") {
    // Git hooks live in config.git.hooks, not config.agents.git — the
    // shape differs enough that --list doesn't carry over cleanly. For
    // now just point users at doctor, which already surfaces this.
    deps.writeErr(
      `✗ hook --list doesn't support the git agent yet. ` +
        `Run 'agent-hooks doctor' to see installed git hooks.\n`,
    );
    return 2;
  }
  const handler = getAgentHandler(agent);
  if (!handler) {
    deps.writeErr(
      `✗ unknown hook agent: "${agent}"\n` +
        `  (try 'agent-hooks agent list' for the full set)\n`,
    );
    return 2;
  }
  const loaded = await loadOrReport(deps);
  if (typeof loaded === "number") return loaded;

  const configKey = configKeyFor(agent);
  const configuredHooks =
    loaded.config.agents?.[configKey]?.hooks ?? {};

  deps.write(`${handler.displayName} (${agent}):\n`);
  for (const event of handler.hookEvents) {
    const rules = configuredHooks[event] ?? [];
    const glyph = rules.length > 0 ? "✓" : "·";
    const count =
      rules.length > 0 ? ` (${String(rules.length)} rule${rules.length === 1 ? "" : "s"})` : "";
    deps.write(`  ${glyph} ${event}${count}\n`);
    for (const rule of rules) {
      const matcher = rule.matcher ?? "*";
      deps.write(`      matcher: ${matcher} → pipeline: ${rule.pipeline}\n`);
    }
  }

  // Surface configured events the handler doesn't recognize — a common
  // source of silent no-ops is a typo'd event name (PostToolUSE vs
  // PostToolUse). Call them out so the user can fix the config.
  const known = new Set(handler.hookEvents);
  const orphans = Object.keys(configuredHooks).filter(
    (name) => !known.has(name),
  );
  if (orphans.length > 0) {
    deps.write(
      `\n  ⚠ configured events not recognized by ${handler.displayName}:\n`,
    );
    for (const orphan of orphans) {
      deps.write(`      - ${orphan}\n`);
    }
  }
  return 0;
}

export function registerHookCommand(
  program: Command,
  overrides: Partial<HookCommandDeps> = {},
): Command {
  return program
    .command("hook")
    .description("Canonical entry point for every agent hook")
    .argument("<agent>", "agent name — e.g. git, claude, gemini-cli")
    .argument(
      "[hook-name]",
      "hook name native to the agent (omit when using --list)",
    )
    .option(
      "--list",
      "list supported hook events and currently configured rules for the agent",
    )
    .action(async function (
      this: Command,
      agent: string,
      hookName: string | undefined,
    ) {
      const flags = this.opts<{ list?: boolean }>();
      const deps: HookCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? defaultRunDeps.write,
        writeErr: overrides.writeErr ?? defaultRunDeps.writeErr,
        load: overrides.load ?? defaultRunDeps.load,
        ...(overrides.loadProject !== undefined
          ? { loadProject: overrides.loadProject }
          : overrides.load === undefined && defaultRunDeps.loadProject
            ? { loadProject: defaultRunDeps.loadProject }
            : {}),
        makeGit: overrides.makeGit ?? defaultRunDeps.makeGit,
        exec: overrides.exec ?? defaultRunDeps.exec,
        env: overrides.env ?? defaultRunDeps.env,
        readStdin:
          overrides.readStdin ??
          (() => readStdinStream(process.stdin)),
      };
      if (flags.list) {
        const code = await runHookListCommand(agent, deps);
        if (code !== 0) throw new ExitError(code);
        return;
      }
      if (!hookName) {
        deps.writeErr(
          `✗ hook <agent> requires <hook-name> (or --list to enumerate events)\n`,
        );
        throw new ExitError(2);
      }
      const code = await runHookCommand(agent, hookName, deps);
      if (code !== 0) throw new ExitError(code);
    });
}
