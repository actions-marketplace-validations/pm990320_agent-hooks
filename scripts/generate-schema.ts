#!/usr/bin/env bun
/**
 * Writes schema.json to the repo root from the zod schema.
 * Run via `bun run generate:schema` or as part of `bun run build`.
 *
 * `--check` mode: exit 0 if the committed schema.json matches the
 * regenerated output, exit 1 otherwise. Used by the `schema-fresh`
 * step in .config/agent-hooks.yml to catch drift in CI.
 */
import path from "node:path";
import { renderConfigJSONSchema } from "../src/config/to-json-schema.ts";

const outPath = path.join(import.meta.dir, "..", "schema.json");
const fresh = renderConfigJSONSchema();

if (process.argv.includes("--check")) {
  const file = Bun.file(outPath);
  const committed = (await file.exists()) ? await file.text() : "";
  if (committed !== fresh) {
    process.stderr.write(
      `schema.json is stale — run: bun run generate:schema\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`schema.json is up-to-date\n`);
  process.exit(0);
}

await Bun.write(outPath, fresh);
process.stdout.write(`wrote ${outPath}\n`);
