import path from "node:path";

export interface BeadsDetection {
  readonly enabled: boolean;
  readonly beadsDir: string | null;
}

export interface BeadsFs {
  exists(p: string): Promise<boolean>;
}

/**
 * Detect whether Beads is active in the given repo. Checks for a
 * `.beads/` directory at the repo root. Config's `beads.enabled: true`
 * or `false` overrides; `auto` (default) uses the filesystem check.
 */
export async function detectBeads(
  cwd: string,
  configEnabled: "auto" | boolean | undefined,
  fs: BeadsFs,
): Promise<BeadsDetection> {
  if (configEnabled === false) {
    return { enabled: false, beadsDir: null };
  }
  const beadsDir = path.join(cwd, ".beads");
  if (configEnabled === true) {
    return { enabled: true, beadsDir };
  }
  // auto or undefined
  const present = await fs.exists(beadsDir);
  return { enabled: present, beadsDir: present ? beadsDir : null };
}
