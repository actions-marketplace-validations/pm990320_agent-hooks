const HEADER_MARKER = "# agent-hooks managed hook — do not edit";
const HASH_PREFIX = "# config-hash: ";

/**
 * Build the shell stub that lives at `.git/hooks/<name>`. Fields:
 *
 *   1. POSIX shebang so the stub works on every git-supported host.
 *   2. Managed-by marker — how the installer recognizes its own stubs.
 *   3. Embedded SHA256 of the agent-hooks config — used for --if-missing.
 *   4. Resolver loop that prefers `./node_modules/.bin/agent-hooks` so
 *      Node-family projects work without a global install. Falls back
 *      to whatever `agent-hooks` is on PATH. Clear error if neither
 *      resolves.
 */
export function buildStub(hookName: string, configHash: string): string {
  return `#!/bin/sh
${HEADER_MARKER}
${HASH_PREFIX}${configHash}
for candidate in "./node_modules/.bin/agent-hooks" "agent-hooks"; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" hook git ${hookName} "$@"
  fi
done
echo "agent-hooks: command not found (managed hook at .git/hooks/${hookName})" >&2
exit 1
`;
}

export interface StubInspection {
  readonly managed: boolean;
  readonly configHash: string | null;
}

/**
 * Inspect an existing hook file and decide whether it's ours. If it is,
 * extract the recorded config hash so the installer can decide whether
 * to rewrite or leave it alone.
 */
export function inspectStub(contents: string): StubInspection {
  const lines = contents.split("\n");
  const hasMarker = lines.some((line) => line.trimEnd() === HEADER_MARKER);
  if (!hasMarker) {
    return { managed: false, configHash: null };
  }
  const hashLine = lines.find((line) => line.startsWith(HASH_PREFIX));
  const configHash = hashLine
    ? hashLine.slice(HASH_PREFIX.length).trim()
    : null;
  return { managed: true, configHash };
}
