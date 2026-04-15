/**
 * Install / uninstall the constant agent-hooks marker block in
 * CLAUDE.md and AGENTS.md. Pure fs side-effects, no I/O policy —
 * the caller decides which files to target and whether to auto-detect.
 *
 * Design invariants:
 *
 *   1. We NEVER write files that don't already exist. Creating a
 *      CLAUDE.md or AGENTS.md from scratch is too presumptuous;
 *      those files belong to the user. We only splice into what's
 *      already there.
 *   2. We NEVER touch content outside the marker block. Hand-edits
 *      elsewhere in the file are byte-for-byte preserved.
 *   3. The block body is CONSTANT — identical bytes for every
 *      project so CLAUDE.md / AGENTS.md stay prompt-cacheable
 *      across repos. Project-specific details live in
 *      `agent-hooks list`, which the block points at.
 */

import path from "node:path";
import {
  computeBlockHash,
  findBlock,
  removeBlock,
  renderBlockBody,
  spliceBlock,
  type SpliceAction,
} from "./block.ts";

/**
 * The canonical list of files this module touches. We keep the list
 * short and ordered so output is deterministic.
 */
export const AGENTS_MD_TARGETS = ["CLAUDE.md", "AGENTS.md"] as const;
export type AgentsMdTarget = (typeof AGENTS_MD_TARGETS)[number];

export interface AgentsMdFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string): Promise<void>;
}

export interface InstallAgentsMdOptions {
  readonly cwd: string;
  readonly fs: AgentsMdFs;
  /**
   * When omitted we touch every file in `AGENTS_MD_TARGETS` that
   * already exists under `cwd`. Pass an explicit list to force a
   * specific subset.
   */
  readonly targets?: readonly AgentsMdTarget[];
  /**
   * When true, don't actually write — just compute what would happen.
   * Used by init --dry-run.
   */
  readonly dryRun?: boolean;
}

export interface AgentsMdOutcome {
  readonly path: string;
  readonly action: SpliceAction | "missing";
}

/**
 * Install the agent-hooks marker block into every target that exists
 * under `cwd`. Returns one outcome per target, including `missing`
 * entries for files we intentionally didn't touch so the caller can
 * report them.
 */
export async function installAgentsMdBlock(
  options: InstallAgentsMdOptions,
): Promise<readonly AgentsMdOutcome[]> {
  const body = renderBlockBody();
  const chosen = options.targets ?? AGENTS_MD_TARGETS;
  const outcomes: AgentsMdOutcome[] = [];
  for (const name of chosen) {
    const full = path.join(options.cwd, name);
    const exists = await options.fs.exists(full);
    if (!exists) {
      outcomes.push({ path: full, action: "missing" });
      continue;
    }
    const current = await options.fs.read(full);
    const spliced = spliceBlock(current, body);
    if (spliced.action === "unchanged") {
      outcomes.push({ path: full, action: "unchanged" });
      continue;
    }
    if (!options.dryRun) {
      await options.fs.write(full, spliced.text);
    }
    outcomes.push({ path: full, action: spliced.action });
  }
  return outcomes;
}

/**
 * Remove the agent-hooks marker block from every target where it
 * exists. Files without the block are reported as `unchanged`.
 */
export async function uninstallAgentsMdBlock(
  options: InstallAgentsMdOptions,
): Promise<readonly AgentsMdOutcome[]> {
  const chosen = options.targets ?? AGENTS_MD_TARGETS;
  const outcomes: AgentsMdOutcome[] = [];
  for (const name of chosen) {
    const full = path.join(options.cwd, name);
    const exists = await options.fs.exists(full);
    if (!exists) {
      outcomes.push({ path: full, action: "missing" });
      continue;
    }
    const current = await options.fs.read(full);
    const removed = removeBlock(current);
    if (removed.action === "unchanged") {
      outcomes.push({ path: full, action: "unchanged" });
      continue;
    }
    if (!options.dryRun) {
      await options.fs.write(full, removed.text);
    }
    outcomes.push({ path: full, action: removed.action });
  }
  return outcomes;
}

/**
 * Probe every target and report whether each has the block and
 * whether its hash matches the current agent-hooks block body. Used
 * by doctor to surface drift after an agent-hooks upgrade.
 */
export interface AgentsMdStatusEntry {
  readonly path: string;
  readonly exists: boolean;
  readonly blockPresent: boolean;
  readonly inSync: boolean;
}

export async function statusAgentsMdBlock(
  options: InstallAgentsMdOptions,
): Promise<readonly AgentsMdStatusEntry[]> {
  const freshHash = computeBlockHash(renderBlockBody());
  const chosen = options.targets ?? AGENTS_MD_TARGETS;
  const entries: AgentsMdStatusEntry[] = [];
  for (const name of chosen) {
    const full = path.join(options.cwd, name);
    const exists = await options.fs.exists(full);
    if (!exists) {
      entries.push({
        path: full,
        exists: false,
        blockPresent: false,
        inSync: false,
      });
      continue;
    }
    const contents = await options.fs.read(full);
    const found = findBlock(contents);
    entries.push({
      path: full,
      exists: true,
      blockPresent: found !== null,
      inSync: found?.hash === freshHash,
    });
  }
  return entries;
}
