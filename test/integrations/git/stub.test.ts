import { describe, expect, test } from "bun:test";
import {
  buildStub,
  inspectStub,
} from "../../../src/integrations/git/stub.ts";

describe("buildStub", () => {
  test("starts with a POSIX shebang", () => {
    expect(buildStub("pre-commit", "abc123").startsWith("#!/bin/sh\n")).toBe(
      true,
    );
  });

  test("includes the managed-by marker and config hash", () => {
    const stub = buildStub("pre-commit", "abc123");
    expect(stub).toContain("agent-hooks managed hook");
    expect(stub).toContain("config-hash: abc123");
  });

  test("execs back into agent-hooks with the hook name", () => {
    const stub = buildStub("pre-push", "hhh");
    expect(stub).toContain('hook git pre-push');
    expect(stub).toContain('"$@"');
  });

  test("includes node_modules/.bin fallback so Node projects don't need a global install", () => {
    const stub = buildStub("pre-commit", "x");
    expect(stub).toContain("./node_modules/.bin/agent-hooks");
  });

  test("prints a readable error when neither resolver finds agent-hooks", () => {
    const stub = buildStub("pre-commit", "x");
    expect(stub).toContain("command not found");
    expect(stub).toContain(".git/hooks/pre-commit");
  });
});

describe("inspectStub", () => {
  test("reports unmanaged for foreign content", () => {
    const info = inspectStub("#!/bin/sh\necho hi\n");
    expect(info.managed).toBe(false);
    expect(info.configHash).toBeNull();
  });

  test("reports managed and extracts the config hash", () => {
    const stub = buildStub("pre-commit", "abc123");
    const info = inspectStub(stub);
    expect(info.managed).toBe(true);
    expect(info.configHash).toBe("abc123");
  });

  test("handles a managed stub with a missing hash line (older version)", () => {
    const stub = "#!/bin/sh\n# agent-hooks managed hook — do not edit\nexec agent-hooks hook git pre-commit\n";
    const info = inspectStub(stub);
    expect(info.managed).toBe(true);
    expect(info.configHash).toBeNull();
  });
});
