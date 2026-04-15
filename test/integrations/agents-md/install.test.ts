import { describe, expect, test } from "bun:test";
import {
  findBlock,
  wrapBlock,
} from "../../../src/integrations/agents-md/block.ts";
import {
  installAgentsMdBlock,
  statusAgentsMdBlock,
  uninstallAgentsMdBlock,
  type AgentsMdFs,
} from "../../../src/integrations/agents-md/install.ts";

function memFs(initial: Record<string, string> = {}): AgentsMdFs & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    exists: (p) => Promise.resolve(files.has(p)),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(v);
    },
    write: (p, contents) => {
      files.set(p, contents);
      return Promise.resolve();
    },
  };
}

// --- installAgentsMdBlock ----------------------------------------------

describe("installAgentsMdBlock", () => {
  test("reports both targets as missing when neither file exists", async () => {
    const fs = memFs();
    const outcomes = await installAgentsMdBlock({ cwd: "/repo", fs });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.action === "missing")).toBe(true);
    expect(fs.files.size).toBe(0);
  });

  test("injects a block into CLAUDE.md when it exists", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": "# Project rules\n\nBe nice.\n",
    });
    const outcomes = await installAgentsMdBlock({ cwd: "/repo", fs });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("inserted");
    const written = fs.files.get("/repo/CLAUDE.md")!;
    expect(written).toContain("# Project rules");
    expect(written).toContain("Be nice.");
    expect(written).toContain("BEGIN AGENT-HOOKS INTEGRATION");
    expect(written).toContain("END AGENT-HOOKS INTEGRATION");
  });

  test("injects into both files when both exist", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": "# Claude\n",
      "/repo/AGENTS.md": "# Agents\n",
    });
    const outcomes = await installAgentsMdBlock({ cwd: "/repo", fs });
    expect(outcomes.every((o) => o.action === "inserted")).toBe(true);
    expect(fs.files.get("/repo/CLAUDE.md")).toContain("BEGIN AGENT-HOOKS");
    expect(fs.files.get("/repo/AGENTS.md")).toContain("BEGIN AGENT-HOOKS");
  });

  test("noop when the block is already in sync", async () => {
    const fs = memFs({ "/repo/CLAUDE.md": "# Claude\n" });
    // First install.
    await installAgentsMdBlock({ cwd: "/repo", fs });
    const snapshot = fs.files.get("/repo/CLAUDE.md")!;
    // Second install should noop — body is a constant.
    const outcomes = await installAgentsMdBlock({ cwd: "/repo", fs });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("unchanged");
    expect(fs.files.get("/repo/CLAUDE.md")).toBe(snapshot);
  });

  test("refreshes a stale block when the stored hash doesn't match", async () => {
    // Simulate a stale block from an older agent-hooks by embedding
    // a hand-rolled wrap with different body bytes.
    const stale = wrapBlock("something old agent-hooks would have written");
    const fs = memFs({
      "/repo/CLAUDE.md": `# Claude\n\n${stale}\n`,
    });
    const outcomes = await installAgentsMdBlock({ cwd: "/repo", fs });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("refreshed");
    const written = fs.files.get("/repo/CLAUDE.md")!;
    expect(written).toContain("BEGIN AGENT-HOOKS");
    expect(written).not.toContain("something old agent-hooks");
  });

  test("preserves content outside the markers byte-for-byte on refresh", async () => {
    const before =
      "# Title\n\npreamble with weird chars: 🧪 ✓ ✗\n\ncode:\n\n```\nfoo\n```\n\n";
    const after = "\n\ntrailing section\n\nwith newlines\n";
    const fs = memFs({
      "/repo/CLAUDE.md": `${before}${wrapBlock("old")}${after}`,
    });
    await installAgentsMdBlock({ cwd: "/repo", fs });
    const written = fs.files.get("/repo/CLAUDE.md")!;
    const found = findBlock(written);
    expect(found).not.toBeNull();
    expect(written.slice(0, found!.start)).toBe(before);
    expect(written.slice(found!.end)).toBe(after);
  });

  test("respects dryRun: reports actions but never writes", async () => {
    const fs = memFs({ "/repo/CLAUDE.md": "# Claude\n" });
    const outcomes = await installAgentsMdBlock({
      cwd: "/repo",
      fs,
      dryRun: true,
    });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("inserted");
    expect(fs.files.get("/repo/CLAUDE.md")).toBe("# Claude\n");
  });

  test("honors an explicit targets list", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": "# Claude\n",
      "/repo/AGENTS.md": "# Agents\n",
    });
    const outcomes = await installAgentsMdBlock({
      cwd: "/repo",
      fs,
      targets: ["AGENTS.md"],
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.path.endsWith("AGENTS.md")).toBe(true);
    // CLAUDE.md untouched.
    expect(fs.files.get("/repo/CLAUDE.md")).toBe("# Claude\n");
  });
});

// --- uninstallAgentsMdBlock --------------------------------------------

describe("uninstallAgentsMdBlock", () => {
  test("removes the block and reports removed", async () => {
    const fs = memFs({ "/repo/CLAUDE.md": "# Claude\n" });
    await installAgentsMdBlock({ cwd: "/repo", fs });
    const outcomes = await uninstallAgentsMdBlock({ cwd: "/repo", fs });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("removed");
    expect(fs.files.get("/repo/CLAUDE.md")).not.toContain(
      "BEGIN AGENT-HOOKS",
    );
    expect(fs.files.get("/repo/CLAUDE.md")).toContain("# Claude");
  });

  test("reports unchanged when the file has no block", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": "# Claude\n\nno block here\n",
    });
    const outcomes = await uninstallAgentsMdBlock({ cwd: "/repo", fs });
    const claude = outcomes.find((o) => o.path.endsWith("CLAUDE.md"));
    expect(claude?.action).toBe("unchanged");
  });

  test("reports missing when the file doesn't exist", async () => {
    const fs = memFs();
    const outcomes = await uninstallAgentsMdBlock({ cwd: "/repo", fs });
    expect(outcomes.every((o) => o.action === "missing")).toBe(true);
  });

  test("dryRun does not mutate the file", async () => {
    const fs = memFs({ "/repo/CLAUDE.md": "# Claude\n" });
    await installAgentsMdBlock({ cwd: "/repo", fs });
    const snapshot = fs.files.get("/repo/CLAUDE.md")!;
    await uninstallAgentsMdBlock({ cwd: "/repo", fs, dryRun: true });
    expect(fs.files.get("/repo/CLAUDE.md")).toBe(snapshot);
  });
});

// --- statusAgentsMdBlock -----------------------------------------------

describe("statusAgentsMdBlock", () => {
  test("reports not-exists for missing files", async () => {
    const fs = memFs();
    const entries = await statusAgentsMdBlock({ cwd: "/repo", fs });
    expect(entries.every((e) => !e.exists)).toBe(true);
    expect(entries.every((e) => !e.blockPresent)).toBe(true);
    expect(entries.every((e) => !e.inSync)).toBe(true);
  });

  test("reports blockPresent + inSync after install", async () => {
    const fs = memFs({ "/repo/CLAUDE.md": "# Claude\n" });
    await installAgentsMdBlock({ cwd: "/repo", fs });
    const entries = await statusAgentsMdBlock({ cwd: "/repo", fs });
    const claude = entries.find((e) => e.path.endsWith("CLAUDE.md"));
    expect(claude?.exists).toBe(true);
    expect(claude?.blockPresent).toBe(true);
    expect(claude?.inSync).toBe(true);
  });

  test("reports blockPresent but NOT inSync when a stale hash is embedded", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": `# Claude\n\n${wrapBlock("ancient body from an old release")}\n`,
    });
    const entries = await statusAgentsMdBlock({ cwd: "/repo", fs });
    const claude = entries.find((e) => e.path.endsWith("CLAUDE.md"));
    expect(claude?.blockPresent).toBe(true);
    expect(claude?.inSync).toBe(false);
  });

  test("reports a file without the block as blockPresent=false", async () => {
    const fs = memFs({
      "/repo/CLAUDE.md": "# Claude\n\nno markers here\n",
    });
    const entries = await statusAgentsMdBlock({ cwd: "/repo", fs });
    const claude = entries.find((e) => e.path.endsWith("CLAUDE.md"));
    expect(claude?.exists).toBe(true);
    expect(claude?.blockPresent).toBe(false);
    expect(claude?.inSync).toBe(false);
  });
});
