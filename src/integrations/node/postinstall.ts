import path from "node:path";

export const POSTINSTALL_COMMAND = "agent-hooks install --if-missing";

export type PostinstallAction =
  | "created"
  | "appended"
  | "replaced"
  | "unchanged"
  | "skipped";

export interface PostinstallPatchResult {
  readonly action: PostinstallAction;
  readonly scripts: Record<string, string>;
}

/**
 * Patch a parsed `package.json`'s `scripts` block so `postinstall` runs
 * `agent-hooks install --if-missing`. Rules:
 *
 *   - Missing postinstall → create it.
 *   - Existing postinstall already contains our command → unchanged.
 *   - Existing foreign postinstall → append with `&&` (mode: "append")
 *     or replace entirely (mode: "replace"). Default is "append".
 */
export function patchPostinstall(
  pkgJson: Record<string, unknown>,
  mode: "append" | "replace" = "append",
): PostinstallPatchResult {
  const scripts: Record<string, string> = {
    ...((pkgJson.scripts as Record<string, string> | undefined) ?? {}),
  };
  const existing = scripts.postinstall;

  if (existing === undefined) {
    scripts.postinstall = POSTINSTALL_COMMAND;
    return { action: "created", scripts };
  }

  if (existing.includes(POSTINSTALL_COMMAND)) {
    return { action: "unchanged", scripts };
  }

  if (mode === "replace") {
    scripts.postinstall = POSTINSTALL_COMMAND;
    return { action: "replaced", scripts };
  }

  scripts.postinstall = `${existing} && ${POSTINSTALL_COMMAND}`;
  return { action: "appended", scripts };
}

export interface PostinstallFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
  write(p: string, contents: string): Promise<void>;
}

export interface WirePostinstallOptions {
  readonly cwd: string;
  readonly fs: PostinstallFs;
  readonly mode?: "append" | "replace";
}

export interface WirePostinstallResult {
  readonly action: PostinstallAction;
  readonly packageJsonPath: string;
}

/**
 * Read `<cwd>/package.json`, apply `patchPostinstall`, and write the
 * result back only if changed. Returns `skipped` when no `package.json`
 * is present — we don't create one from scratch.
 */
export async function wirePostinstall(
  options: WirePostinstallOptions,
): Promise<WirePostinstallResult> {
  const pkgPath = path.join(options.cwd, "package.json");
  if (!(await options.fs.exists(pkgPath))) {
    return { action: "skipped", packageJsonPath: pkgPath };
  }

  const raw = await options.fs.read(pkgPath);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { action, scripts } = patchPostinstall(parsed, options.mode);

  if (action === "unchanged") {
    return { action, packageJsonPath: pkgPath };
  }

  const next = { ...parsed, scripts };
  // Preserve trailing newline if the original had one.
  const trailing = raw.endsWith("\n") ? "\n" : "";
  await options.fs.write(
    pkgPath,
    `${JSON.stringify(next, null, 2)}${trailing}`,
  );
  return { action, packageJsonPath: pkgPath };
}
