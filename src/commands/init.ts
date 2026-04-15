import type { Command } from "commander";
import nodeFs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import YAML from "yaml";
import { ExitError } from "../cli.ts";
import { ConfigSchema } from "../config/schema.ts";
import {
  defaultHookFs,
  installHooks,
  type HookFs,
} from "../integrations/git/install.ts";
import { mergeDetectors } from "../integrations/detectors/merge.ts";
import {
  DETECTORS,
  getDetector,
} from "../integrations/detectors/registry.ts";
import {
  FALLBACK_FRAGMENT,
  renderConfigYaml,
} from "../integrations/detectors/render.ts";
import type { Detector, DetectorFs } from "../integrations/detectors/types.ts";
import {
  wirePostinstall,
  type PostinstallFs,
} from "../integrations/node/postinstall.ts";
import {
  AGENTS_MD_TARGETS,
  installAgentsMdBlock,
  type AgentsMdFs,
  type AgentsMdOutcome,
  type AgentsMdTarget,
} from "../integrations/agents-md/install.ts";
import {
  defaultSkillFs,
  installSkill,
  type SkillFs,
  type SkillTarget,
} from "../integrations/skill/install.ts";
import { SKILL_TARGETS } from "./agent.ts";
import {
  canSemanticMerge,
  createInteractivePrompter,
  diffLines,
  formatDiff,
  mergeYamlConfigs,
  nonInteractiveKeepPrompter,
  textsDiffer,
  type ConflictChoice,
  type ConflictPrompter,
} from "./init-conflicts.ts";

export interface InitFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string, mode?: number): Promise<void>;
  mkdirRecursive(p: string): Promise<void>;
  /**
   * List the file names (not full paths) inside `dir`. Returns an
   * empty array if the directory doesn't exist — callers don't want
   * to branch on every missing-dir case.
   */
  list?(dir: string): Promise<readonly string[]>;
}

export interface InitCommandDeps {
  readonly cwd: string;
  readonly write: (text: string) => void;
  readonly fs: InitFs;
  readonly hookFs: HookFs;
  readonly postinstallFs: PostinstallFs;
  /**
   * Interactive prompter used when an existing file differs from what
   * init would write. Defaults to the non-interactive "keep" prompter
   * so piped / scripted runs never block. The commander wiring swaps in
   * a TTY-backed prompter when stdin is a terminal.
   */
  readonly prompter?: ConflictPrompter;
  /**
   * Filesystem adapter for the skill-install side-effect. Tests inject
   * an in-memory one so `--with-skill` doesn't write to real home
   * directories; defaults to the real fs adapter.
   */
  readonly skillFs?: SkillFs;
  /**
   * Filesystem adapter for CLAUDE.md / AGENTS.md marker-block
   * splicing. Tests inject an in-memory one; defaults to the real
   * fs adapter wrapping InitFs.
   */
  readonly agentsMdFs?: AgentsMdFs;
}

export interface InitArgs {
  readonly force?: boolean;
  readonly dryRun?: boolean;
  readonly withPostinstall?: boolean;
  readonly noPostinstall?: boolean;
  readonly withGithubActions?: boolean;
  readonly noGithubActions?: boolean;
  /** Force a specific detector template, bypassing auto-detection. */
  readonly template?: string;
  /** Skip detectors entirely and write the fallback skeleton. */
  readonly noTemplates?: boolean;
  /** Project name for the generated config (`name:` field). */
  readonly name?: string;
  /**
   * Override the GitHub Actions workflow file name. Defaults to
   * `agent-hooks.yml`; useful when `agent-hooks.yml` is already in use
   * for something else or when an existing `ci.yml` needs an avoidance.
   */
  readonly workflowName?: string;
  /**
   * Install the agent-hooks skill file for a target as part of init.
   * Pass the target name (claude/cursor/codex) to install for that
   * agent, or the literal `"auto"` to install for every detected
   * agent. Per PLAN §6.5 lines 1319–1322.
   */
  readonly withSkill?: string;
  /**
   * Explicitly suppress the skill install. Matches the PLAN's
   * `--no-skill` semantic — today's default is already "no install"
   * so this is effectively documentation-only, but accepting the flag
   * keeps scripts forward-compatible with future interactive prompts.
   */
  readonly noSkill?: boolean;
  /**
   * Inject the agent-hooks marker block into CLAUDE.md / AGENTS.md.
   * - Undefined (default): auto-detect — inject into every target that
   *   already exists under `cwd`, skip any that don't.
   * - Explicit target list: only touch those files (still skip if
   *   they don't exist — init never creates these files).
   * - `false`: never touch CLAUDE.md / AGENTS.md.
   *
   * Init never creates CLAUDE.md / AGENTS.md from scratch; those files
   * belong to the user. The block body is a constant — identical bytes
   * across every project so the files stay prompt-cacheable.
   */
  readonly withAgentsMd?: readonly AgentsMdTarget[] | false;
  /**
   * Control how `postinstall` is patched into `package.json`:
   *
   *   - `append`  → prefix the existing command with ours (default).
   *   - `replace` → overwrite whatever's there.
   *   - `skip`    → leave the script alone (same as --no-postinstall).
   *
   * When unspecified, init honors the `install.postinstall-mode` field
   * in an existing config if one's present, otherwise falls back to
   * `append`.
   */
  readonly postinstallMode?: "append" | "replace" | "skip";
}

// --- Starter config template --------------------------------------------

/**
 * The default config written when no stack detector fires. Generated
 * from `FALLBACK_FRAGMENT` via `renderConfigYaml` so the constant
 * cannot drift from the real init output. Tests assert against this
 * to pin the no-detector path.
 */
export const STARTER_CONFIG = renderConfigYaml(FALLBACK_FRAGMENT);

export const STARTER_WORKFLOW = `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
      - run: agent-hooks ci
`;

// --- Core action ---------------------------------------------------------

export interface InitOutcome {
  readonly wroteConfig: boolean;
  readonly wroteWorkflow: boolean;
  readonly installedHooks: number;
  readonly postinstall:
    | "skipped"
    | "created"
    | "appended"
    | "replaced"
    | "unchanged";
  /** Detector names that contributed to the generated config. */
  readonly detectors: readonly string[];
  /** Skill targets installed (or planned) during init, if any. */
  readonly skillsInstalled: readonly string[];
  /** Outcome of the CLAUDE.md / AGENTS.md marker-block splice. */
  readonly agentsMd: readonly AgentsMdOutcome[];
}

function initFsAsDetectorFs(fs: InitFs): DetectorFs {
  return {
    exists: (p) => fs.exists(p),
    read: (p) => fs.read(p),
  };
}

async function resolveFragment(
  args: InitArgs,
  deps: InitCommandDeps,
): Promise<{
  steps: Record<string, unknown>;
  pipelines: Record<string, unknown>;
  gitHooks: Record<string, unknown>;
  detectorNames: readonly string[];
  notes: readonly string[];
}> {
  if (args.noTemplates === true) {
    return { ...FALLBACK_FRAGMENT };
  }
  if (args.template !== undefined) {
    const detector = getDetector(args.template);
    if (!detector) {
      throw new Error(
        `unknown detector template: "${args.template}" (known: ${DETECTORS.map((d) => d.name).join(", ")})`,
      );
    }
    const forced: Detector[] = [
      {
        name: detector.name,
        displayName: detector.displayName,
        detect: () => Promise.resolve(true),
        template: (ctx) => detector.template(ctx),
      },
    ];
    const merged = await mergeDetectors(
      { cwd: deps.cwd, fs: initFsAsDetectorFs(deps.fs) },
      forced,
    );
    if (merged.detectorNames.length === 0) return { ...FALLBACK_FRAGMENT };
    return merged;
  }
  const merged = await mergeDetectors({
    cwd: deps.cwd,
    fs: initFsAsDetectorFs(deps.fs),
  });
  if (merged.detectorNames.length === 0) return { ...FALLBACK_FRAGMENT };
  return merged;
}

interface WritePlanInput {
  readonly deps: InitCommandDeps;
  readonly prompter: ConflictPrompter;
  readonly args: InitArgs;
  readonly path: string;
  readonly newContents: string;
}

/**
 * Plan and execute a single file write. Handles the three cases:
 *
 *   1. File does not exist → write it (respecting --dry-run).
 *   2. File exists, content matches → report "up to date", no write.
 *   3. File exists, content differs → diff preview + user decision
 *      (keep / overwrite / merge / skip). --force short-circuits to
 *      overwrite with a backup; --dry-run prints the diff but never
 *      writes.
 *
 * Returns whether a write would (or did) occur so the caller can
 * summarize the outcome.
 */
async function writePlannedFile(
  input: WritePlanInput,
): Promise<{ wrote: boolean; choice: ConflictChoice | "new" | "up-to-date" }> {
  const { deps, prompter, args, path: targetPath, newContents } = input;
  const exists = await deps.fs.exists(targetPath);

  if (!exists) {
    if (args.dryRun) {
      deps.write(`  plan    ${targetPath}\n`);
    } else {
      await deps.fs.mkdirRecursive(path.dirname(targetPath));
      await deps.fs.write(targetPath, newContents);
      deps.write(`  wrote   ${targetPath}\n`);
    }
    return { wrote: true, choice: "new" };
  }

  const oldContents = await deps.fs.read(targetPath);
  if (!textsDiffer(oldContents, newContents)) {
    deps.write(`  ok      ${targetPath} (up to date)\n`);
    return { wrote: false, choice: "up-to-date" };
  }

  // --force always wins without prompting — users asked for it.
  if (args.force) {
    if (args.dryRun) {
      deps.write(`  would   back up ${targetPath} → ${targetPath}.bak\n`);
      deps.write(`  plan    overwrite ${targetPath}\n`);
    } else {
      const backupPath = `${targetPath}.bak`;
      await deps.fs.write(backupPath, oldContents);
      deps.write(`  backup  ${backupPath}\n`);
      await deps.fs.write(targetPath, newContents);
      deps.write(`  wrote   ${targetPath}\n`);
    }
    return { wrote: true, choice: "overwrite" };
  }

  const diffText = formatDiff(diffLines(oldContents, newContents));

  // --dry-run: show the diff, then report what init *would* prompt the
  // user to decide. No prompt, no write.
  if (args.dryRun) {
    deps.write(`  diff    ${targetPath}\n${diffText}\n`);
    deps.write(`  plan    conflict — re-run without --dry-run to resolve\n`);
    return { wrote: false, choice: "keep" };
  }

  const canMerge = canSemanticMerge(targetPath);
  const choice = await prompter.prompt({
    path: targetPath,
    diff: diffText,
    canMerge,
  });
  if (choice === "keep") {
    deps.write(`  keep    ${targetPath}\n`);
    return { wrote: false, choice };
  }
  if (choice === "skip") {
    deps.write(`  skip    ${targetPath}\n`);
    return { wrote: false, choice };
  }
  if (choice === "overwrite") {
    const backupPath = `${targetPath}.bak`;
    await deps.fs.write(backupPath, oldContents);
    deps.write(`  backup  ${backupPath}\n`);
    await deps.fs.write(targetPath, newContents);
    deps.write(`  wrote   ${targetPath}\n`);
    return { wrote: true, choice };
  }
  // merge — only offered when canSemanticMerge. Attempt a conservative
  // additive merge; if the merger bails (unparseable input, etc.) we
  // fall back to a keep with an explanation so the user can retry.
  const merged = mergeYamlConfigs(oldContents, newContents);
  if (merged === null) {
    deps.write(
      `  merge   refused (parse error or unsupported shape) — keeping ${targetPath}\n`,
    );
    return { wrote: false, choice: "keep" };
  }
  const backupPath = `${targetPath}.bak`;
  await deps.fs.write(backupPath, oldContents);
  deps.write(`  backup  ${backupPath}\n`);
  await deps.fs.write(targetPath, merged);
  deps.write(`  merged  ${targetPath}\n`);
  return { wrote: true, choice };
}

/**
 * Line-level check for an `uses: pm990320/agent-hooks` action reference.
 * Strips YAML comments first so a documentation reference never trips
 * the scanner. Matches `uses: pm990320/agent-hooks` followed by `@`,
 * whitespace, or end-of-line.
 */
function hasAgentHooksUsesDirective(contents: string): boolean {
  for (const raw of contents.split("\n")) {
    // Strip comment (everything from the first unquoted `#` on). Naive
    // by design — workflows almost never put `#` inside quoted strings,
    // and a false negative here is strictly safer than a false positive.
    const hashAt = raw.indexOf("#");
    const code = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
    if (/uses:\s*pm990320\/agent-hooks(?:@|\s|$)/.test(code)) {
      return true;
    }
  }
  return false;
}

/**
 * Decide which workflow filename to use and whether we should even
 * write one. Returns `{ skip: true, reason }` when an existing workflow
 * already wires up `pm990320/agent-hooks`, so init stays idempotent and
 * doesn't create a second CI job stepping on the first. `--force`
 * bypasses the scan.
 *
 * The scan only matches on the `uses: pm990320/agent-hooks` action
 * reference — tokens like `agent-hooks` in a comment or a custom step
 * name never trigger a false positive.
 */
async function resolveWorkflow(
  args: InitArgs,
  deps: InitCommandDeps,
): Promise<
  | { skip: true; reason: string; path: string }
  | { skip: false; path: string }
> {
  const workflowsDir = path.join(deps.cwd, ".github", "workflows");
  const fileName = args.workflowName ?? "agent-hooks.yml";
  const chosen = path.join(workflowsDir, fileName);

  if (args.force) return { skip: false, path: chosen };

  // Scan every existing workflow for an `uses: pm990320/agent-hooks`
  // reference. If one is already wired up, we report the filename
  // back so the caller can tell the user where the conflict lives.
  const entries = deps.fs.list ? await deps.fs.list(workflowsDir) : [];
  for (const entry of entries) {
    if (!entry.endsWith(".yml") && !entry.endsWith(".yaml")) continue;
    const full = path.join(workflowsDir, entry);
    let contents: string;
    try {
      contents = await deps.fs.read(full);
    } catch {
      continue;
    }
    if (hasAgentHooksUsesDirective(contents)) {
      return {
        skip: true,
        path: full,
        reason: `already wired up in ${full}`,
      };
    }
  }
  return { skip: false, path: chosen };
}

/**
 * Best-effort read of an existing `.config/agent-hooks.yml`'s
 * `install.postinstall` field. Missing config, parse errors, and
 * schema failures all collapse to `{ mode: null }` — we never fail init
 * over a malformed existing config; the conflict-resolution path
 * handles that separately.
 */
async function readExistingInstallConfig(
  deps: InitCommandDeps,
): Promise<{ mode: "auto" | "managed" | "off" | null }> {
  const configPath = path.join(deps.cwd, ".config", "agent-hooks.yml");
  if (!(await deps.fs.exists(configPath))) return { mode: null };
  try {
    const contents = await deps.fs.read(configPath);
    const parsed = YAML.parse(contents) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return { mode: null };
    const install = parsed.install;
    if (!install || typeof install !== "object") return { mode: null };
    const raw = (install as Record<string, unknown>).postinstall;
    if (raw === "auto" || raw === "managed" || raw === "off") {
      return { mode: raw };
    }
    return { mode: null };
  } catch {
    return { mode: null };
  }
}

interface PostinstallDecisionInput {
  readonly args: InitArgs;
  readonly existingMode: "auto" | "managed" | "off" | null;
  readonly packageJsonExists: boolean;
}

interface PostinstallDecision {
  readonly patch: boolean;
  readonly mode: "append" | "replace";
  readonly reason?: string;
}

/**
 * Decide whether and how to patch `package.json`'s `postinstall` given
 * the layered inputs. Exported for direct unit-testing so every layer
 * can be exercised without standing up a full init.
 */
export function decidePostinstall(
  input: PostinstallDecisionInput,
): PostinstallDecision {
  const { args, existingMode, packageJsonExists } = input;
  // Layer 1: hard CLI opt-outs.
  if (args.noPostinstall === true) {
    return { patch: false, mode: "append", reason: "--no-postinstall" };
  }
  if (args.postinstallMode === "skip") {
    return {
      patch: false,
      mode: "append",
      reason: "--postinstall-mode=skip",
    };
  }
  // Layer 2: existing config wins over auto-detection. `managed` means
  // the user maintains package.json themselves; `off` means don't patch.
  if (existingMode === "managed") {
    return {
      patch: false,
      mode: "append",
      reason: "install.postinstall: managed",
    };
  }
  if (existingMode === "off") {
    return {
      patch: false,
      mode: "append",
      reason: "install.postinstall: off",
    };
  }
  // Layer 3: --with-postinstall is a hard opt-in.
  const mode: "append" | "replace" =
    args.postinstallMode === "replace" ? "replace" : "append";
  if (args.withPostinstall === true) {
    return { patch: true, mode };
  }
  // Layer 4: default — patch iff package.json exists.
  if (packageJsonExists) {
    return { patch: true, mode };
  }
  return { patch: false, mode: "append" };
}

export async function runInitCommand(
  args: InitArgs,
  deps: InitCommandDeps,
): Promise<{ code: number; outcome: InitOutcome }> {
  const configPath = path.join(deps.cwd, ".config", "agent-hooks.yml");

  let wroteConfig = false;
  let wroteWorkflow = false;

  // Read any existing `install.postinstall` setting *before* we touch
  // the config file — otherwise a --force run would overwrite the
  // existing config and we'd lose the signal that tells us to skip
  // package.json patching. This is a read-only peek; errors collapse
  // to "no config detected" and the caller falls through to defaults.
  const installCfg = await readExistingInstallConfig(deps);

  const fragment = await resolveFragment(args, deps);
  const configYaml = renderConfigYaml(
    {
      steps: fragment.steps as typeof FALLBACK_FRAGMENT.steps,
      pipelines: fragment.pipelines as typeof FALLBACK_FRAGMENT.pipelines,
      gitHooks: fragment.gitHooks as typeof FALLBACK_FRAGMENT.gitHooks,
      detectorNames: fragment.detectorNames,
      notes: fragment.notes,
    },
    args.name ?? "my-project",
  );

  // Print a short plan summary so users see which detectors fired.
  if (fragment.detectorNames.length > 0) {
    deps.write(
      `  detect  ${fragment.detectorNames.join(", ")}\n`,
    );
  } else {
    deps.write(`  detect  none — using minimal skeleton\n`);
  }

  const prompter = deps.prompter ?? nonInteractiveKeepPrompter;

  const configWrite = await writePlannedFile({
    deps,
    prompter,
    args,
    path: configPath,
    newContents: configYaml,
  });
  wroteConfig = configWrite.wrote;

  // Optionally scaffold the GitHub Actions workflow.
  let githubEnabled: boolean;
  if (args.noGithubActions) {
    githubEnabled = false;
  } else if (args.withGithubActions) {
    githubEnabled = true;
  } else {
    // Default: enable if the repo already has a .github directory, else skip.
    githubEnabled = await deps.fs.exists(path.join(deps.cwd, ".github"));
  }

  if (githubEnabled) {
    const plan = await resolveWorkflow(args, deps);
    if (plan.skip) {
      deps.write(`  skip    ${plan.path} (${plan.reason})\n`);
    } else {
      const workflowWrite = await writePlannedFile({
        deps,
        prompter,
        args,
        path: plan.path,
        newContents: STARTER_WORKFLOW,
      });
      wroteWorkflow = workflowWrite.wrote;
    }
  }

  // Install git hook stubs (unless dry-running). Parse the YAML we
  // just rendered so the hook installer sees exactly the same config
  // we're writing.
  let installedHooks = 0;
  if (!args.dryRun) {
    const parsedDoc = YAML.parse(configYaml) as Record<string, unknown>;
    const config = ConfigSchema.parse(parsedDoc);
    const install = await installHooks({
      gitRoot: deps.cwd,
      config,
      fs: deps.hookFs,
    });
    installedHooks = install.outcomes.length;
    for (const outcome of install.outcomes) {
      deps.write(`  ${outcome.status.padEnd(8)} ${outcome.path}\n`);
    }
  } else {
    deps.write(`  plan    install .git/hooks/<configured hooks>\n`);
  }

  // Optionally wire the postinstall script. The decision layers are:
  //
  //   1. --no-postinstall                          → always skip
  //   2. args.postinstallMode === "skip"           → always skip
  //   3. existing config's install.postinstall     → honor it
  //      - "off"     → skip
  //      - "managed" → skip (user owns package.json)
  //      - "auto"    → patch (same as no config)
  //   4. --with-postinstall                         → force patch
  //   5. default: patch iff package.json exists
  //
  // Existing-config lookup already ran at the top of runInitCommand
  // so the value reflects what was on disk *before* writePlannedFile
  // replaced the config.
  let postinstall: InitOutcome["postinstall"] = "skipped";
  const postinstallDecision = decidePostinstall({
    args,
    existingMode: installCfg.mode,
    packageJsonExists: await deps.fs.exists(
      path.join(deps.cwd, "package.json"),
    ),
  });
  if (postinstallDecision.patch) {
    if (args.dryRun) {
      deps.write(
        `  plan    wire postinstall (${postinstallDecision.mode}) in package.json\n`,
      );
    } else {
      const result = await wirePostinstall({
        cwd: deps.cwd,
        fs: deps.postinstallFs,
        mode: postinstallDecision.mode,
      });
      postinstall = result.action;
      deps.write(`  ${result.action.padEnd(8)} ${result.packageJsonPath}\n`);
    }
  } else if (postinstallDecision.reason) {
    deps.write(`  skip    postinstall (${postinstallDecision.reason})\n`);
  }

  // Optionally install the agent-hooks skill file per PLAN §6.5. The
  // default is to do nothing — skill install is opt-in via --with-skill
  // either as "--with-skill claude" (one target) or "--with-skill auto"
  // (every SKILL_TARGETS entry that resolves to a writable location).
  // --no-skill is accepted as a no-op for forward compatibility with
  // future interactive prompting.
  let skillInstalled: readonly string[] = [];
  if (args.withSkill && !args.noSkill) {
    skillInstalled = await installRequestedSkills({
      deps,
      target: args.withSkill,
      dryRun: args.dryRun === true,
    });
  }

  // Inject the agent-hooks marker block into CLAUDE.md / AGENTS.md.
  // Auto-detect by default — any target file that already exists gets
  // the block, missing ones are ignored silently. --no-agents-md (via
  // `withAgentsMd: false`) disables the whole pass.
  const agentsMdOutcomes = await maybeInstallAgentsMdBlock({
    deps,
    args,
  });
  for (const outcome of agentsMdOutcomes) {
    if (outcome.action === "missing") continue;
    const label =
      outcome.action === "inserted"
        ? "wrote"
        : outcome.action === "refreshed"
          ? "updated"
          : outcome.action === "removed"
            ? "removed"
            : "ok";
    deps.write(`  ${label.padEnd(8)}${outcome.path} (agent-hooks block)\n`);
  }

  deps.write(`✓ init ${args.dryRun ? "(dry run)" : "complete"}\n`);
  return {
    code: 0,
    outcome: {
      wroteConfig,
      wroteWorkflow,
      installedHooks,
      postinstall,
      detectors: fragment.detectorNames,
      skillsInstalled: skillInstalled,
      agentsMd: agentsMdOutcomes,
    },
  };
}

async function maybeInstallAgentsMdBlock(input: {
  deps: InitCommandDeps;
  args: InitArgs;
}): Promise<readonly AgentsMdOutcome[]> {
  const { deps, args } = input;
  if (args.withAgentsMd === false) return [];
  const fs = deps.agentsMdFs ?? initFsAsAgentsMdFs(deps.fs);
  const targets =
    Array.isArray(args.withAgentsMd) && args.withAgentsMd.length > 0
      ? args.withAgentsMd
      : AGENTS_MD_TARGETS;
  return installAgentsMdBlock({
    cwd: deps.cwd,
    fs,
    targets,
    ...(args.dryRun ? { dryRun: true } : {}),
  });
}

function initFsAsAgentsMdFs(fs: InitFs): AgentsMdFs {
  return {
    exists: (p) => fs.exists(p),
    read: (p) => fs.read(p),
    write: (p, contents) => fs.write(p, contents),
  };
}

async function installRequestedSkills(input: {
  deps: InitCommandDeps;
  target: string;
  dryRun: boolean;
}): Promise<readonly string[]> {
  const { deps, target, dryRun } = input;
  const targets: readonly SkillTarget[] =
    target === "auto" ? SKILL_TARGETS : [target as SkillTarget];
  const installed: string[] = [];
  for (const t of targets) {
    if (!isSkillTarget(t)) {
      deps.write(`  skip    skill (unknown target: ${String(t)})\n`);
      continue;
    }
    if (dryRun) {
      deps.write(`  plan    install skill for ${t}\n`);
      installed.push(t);
      continue;
    }
    try {
      const result = await installSkill({
        target: t,
        scope: "user",
        repoCwd: deps.cwd,
        fs: deps.skillFs ?? defaultSkillFs,
      });
      deps.write(`  skill   ${result.filePath}\n`);
      installed.push(t);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.write(`  ⚠ skill install failed for ${t}: ${msg}\n`);
    }
  }
  return installed;
}

function isSkillTarget(value: string): value is SkillTarget {
  return (SKILL_TARGETS as readonly string[]).includes(value);
}

// --- Default FS adapter --------------------------------------------------

export const defaultInitFs: InitFs = {
  async exists(p) {
    try {
      await nodeFs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  read(p) {
    return nodeFs.readFile(p, "utf8");
  },
  async write(p, contents, mode) {
    await nodeFs.writeFile(p, contents, "utf8");
    if (mode !== undefined) {
      await nodeFs.chmod(p, mode);
    }
  },
  async mkdirRecursive(p) {
    await nodeFs.mkdir(p, { recursive: true });
  },
  async list(dir) {
    try {
      return await nodeFs.readdir(dir);
    } catch {
      return [];
    }
  },
};

export const defaultPostinstallFs: PostinstallFs = {
  exists: (p) => defaultInitFs.exists(p),
  read: (p) => defaultInitFs.read(p),
  write: (p, contents) => defaultInitFs.write(p, contents),
};

/**
 * Pick a conflict prompter based on whether stdin looks interactive.
 * A TTY → line-reader prompter; anything else → the keep-everything
 * fallback so piped / scripted `init` runs never block waiting for
 * input that will never come.
 */
export function defaultConflictPrompter(): ConflictPrompter {
  if (!process.stdin.isTTY) {
    return nonInteractiveKeepPrompter;
  }
  return createInteractivePrompter({
    write: (text) => process.stdout.write(text),
    read: (prompt) =>
      new Promise<string>((resolve) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question(prompt, (answer) => {
          rl.close();
          resolve(answer);
        });
      }),
  });
}

// --- Commander registration ---------------------------------------------

export function registerInitCommand(
  program: Command,
  overrides: Partial<InitCommandDeps> = {},
): Command {
  return program
    .command("init")
    .description(
      "Scaffold config, install git hooks, optionally wire postinstall + CI",
    )
    .option("--force", "overwrite existing files")
    .option("--dry-run", "print planned actions without writing")
    .option("--with-postinstall", "force postinstall wiring")
    .option("--no-postinstall", "skip postinstall wiring")
    .option("--with-github-actions", "force GH Actions workflow scaffolding")
    .option("--no-github-actions", "skip GH Actions workflow scaffolding")
    .option(
      "--workflow-name <file>",
      "override the GitHub Actions workflow filename (default: agent-hooks.yml)",
    )
    .option(
      "--postinstall-mode <mode>",
      "how to patch package.json's postinstall: append (default) | replace | skip",
    )
    .option(
      "--with-skill <target>",
      `install the agent-hooks skill for the named target (${SKILL_TARGETS.join(
        "|",
      )}|auto)`,
    )
    .option("--no-skill", "explicitly skip the skill install")
    .option(
      "--no-agents-md",
      "skip injecting the agent-hooks marker block into CLAUDE.md / AGENTS.md",
    )
    .action(async function (this: Command) {
      const flags: {
        force?: boolean;
        dryRun?: boolean;
        postinstall?: boolean;
        githubActions?: boolean;
        withPostinstall?: boolean;
        withGithubActions?: boolean;
        workflowName?: string;
        postinstallMode?: string;
        withSkill?: string;
        skill?: boolean;
        agentsMd?: boolean;
      } = this.opts();
      const deps: InitCommandDeps = {
        cwd: overrides.cwd ?? process.cwd(),
        write: overrides.write ?? ((t) => process.stdout.write(t)),
        fs: overrides.fs ?? defaultInitFs,
        hookFs: overrides.hookFs ?? defaultHookFs,
        postinstallFs: overrides.postinstallFs ?? defaultPostinstallFs,
        prompter: overrides.prompter ?? defaultConflictPrompter(),
      };
      // Commander's --no-foo sets flags.foo = false; --foo sets true.
      const args: InitArgs = {
        ...(flags.force ? { force: true } : {}),
        ...(flags.dryRun ? { dryRun: true } : {}),
        ...(flags.postinstall === false ? { noPostinstall: true } : {}),
        ...(flags.postinstall === true ? { withPostinstall: true } : {}),
        ...(flags.githubActions === false ? { noGithubActions: true } : {}),
        ...(flags.githubActions === true ? { withGithubActions: true } : {}),
        ...(flags.workflowName ? { workflowName: flags.workflowName } : {}),
        ...(flags.postinstallMode === "append" ||
        flags.postinstallMode === "replace" ||
        flags.postinstallMode === "skip"
          ? { postinstallMode: flags.postinstallMode }
          : {}),
        ...(flags.withSkill ? { withSkill: flags.withSkill } : {}),
        ...(flags.skill === false ? { noSkill: true } : {}),
        ...(flags.agentsMd === false ? { withAgentsMd: false as const } : {}),
      };
      const { code } = await runInitCommand(args, deps);
      if (code !== 0) throw new ExitError(code);
    });
}
