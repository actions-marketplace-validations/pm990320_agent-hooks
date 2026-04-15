import { createHash } from "node:crypto";
import type { Config } from "../../config/schema.ts";

/**
 * Compute a stable SHA256 hash of a subset of the config that affects
 * git-hook stub generation. Currently this is just the `git` section,
 * but it's isolated here so we can expand the inputs later without
 * invalidating the hash-header semantics inside stub files.
 */
export function configHash(config: Config): string {
  const payload = JSON.stringify({ git: config.git ?? null });
  return createHash("sha256").update(payload).digest("hex");
}
