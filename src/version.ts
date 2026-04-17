import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
// Strip the npm scope prefix if present — the CLI command is always
// `agent-hooks`, not `@pm990320/agent-hooks`.
export const NAME: string = pkg.name.replace(/^@[^/]+\//, "");
