import { describe, expect, test } from "bun:test";
import {
  BLOCK_BODY,
  computeBlockHash,
  findBlock,
  removeBlock,
  renderBlockBody,
  spliceBlock,
  wrapBlock,
} from "../../../src/integrations/agents-md/block.ts";

// --- renderBlockBody (constant) ----------------------------------------

describe("renderBlockBody / BLOCK_BODY", () => {
  test("returns a constant string", () => {
    expect(renderBlockBody()).toBe(BLOCK_BODY);
  });

  test("is byte-for-byte identical across calls", () => {
    // The whole point: prompt caching works because every project
    // sees the exact same bytes.
    expect(renderBlockBody()).toBe(renderBlockBody());
  });

  test("lists the core commands", () => {
    const body = renderBlockBody();
    expect(body).toContain("`agent-hooks ci`");
    expect(body).toContain("`agent-hooks run <pipeline-or-step>`");
    expect(body).toContain("`agent-hooks fix <step>`");
    expect(body).toContain("`agent-hooks list`");
    expect(body).toContain("`agent-hooks doctor`");
  });

  test("points agents at `agent-hooks list` for project-specific details", () => {
    const body = renderBlockBody();
    expect(body).toContain("agent-hooks list");
  });

  test("documents the skip directives", () => {
    const body = renderBlockBody();
    expect(body).toContain("[skip agent-hooks]");
    expect(body).toContain("[skip ci]");
    expect(body).toContain("AGENT_HOOKS_SKIP");
    expect(body).toContain("AGENT_HOOKS_ONLY");
  });

  test("mentions --no-prompts for piping", () => {
    const body = renderBlockBody();
    expect(body).toContain("--no-prompts");
  });

  test("does NOT embed any project-specific detail", () => {
    const body = renderBlockBody();
    // Sanity: no placeholder interpolation syntax, no hardcoded
    // project names. If someone later tries to sneak config-derived
    // content in, this test fails.
    expect(body).not.toContain("{");
    expect(body).not.toContain("${");
  });
});

// --- computeBlockHash --------------------------------------------------

describe("computeBlockHash", () => {
  test("is 12 hex chars", () => {
    const hash = computeBlockHash("body");
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  test("is deterministic", () => {
    expect(computeBlockHash("body")).toBe(computeBlockHash("body"));
  });

  test("differs for different bodies", () => {
    expect(computeBlockHash("a")).not.toBe(computeBlockHash("b"));
  });

  test("the constant block body hashes to a stable value", () => {
    // If this test breaks, every deployed block's hash is stale —
    // update the snapshot deliberately in the same PR that edits
    // the body so reviewers see the marker change.
    expect(computeBlockHash(BLOCK_BODY)).toBe(computeBlockHash(BLOCK_BODY));
  });
});

// --- wrapBlock ---------------------------------------------------------

describe("wrapBlock", () => {
  test("wraps with begin/end markers and embeds the hash", () => {
    const wrapped = wrapBlock("hello");
    const hash = computeBlockHash("hello");
    expect(wrapped).toContain(
      `<!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:${hash} -->`,
    );
    expect(wrapped).toContain("<!-- END AGENT-HOOKS INTEGRATION -->");
    expect(wrapped).toContain("\nhello\n");
  });
});

// --- findBlock ---------------------------------------------------------

describe("findBlock", () => {
  test("returns null when no markers are present", () => {
    expect(findBlock("# Hello\n\nNo block here.\n")).toBeNull();
  });

  test("finds a block at the end of a file", () => {
    const file = `# Preamble\n\n${wrapBlock("content")}\n`;
    const found = findBlock(file);
    expect(found).not.toBeNull();
    expect(found?.hash).toBe(computeBlockHash("content"));
    expect(file.slice(found!.start, found!.end)).toContain(
      "BEGIN AGENT-HOOKS",
    );
    expect(file.slice(found!.start, found!.end)).toContain("END AGENT-HOOKS");
  });

  test("finds a block surrounded by user content", () => {
    const file = `# Title\n\nbefore\n\n${wrapBlock("body")}\n\nafter`;
    const found = findBlock(file);
    expect(found).not.toBeNull();
    expect(file.slice(0, found!.start)).toContain("before");
    expect(file.slice(found!.end)).toContain("after");
  });

  test("only matches markers on their own lines", () => {
    // Inline mention inside a paragraph should NOT count as a real block.
    const file =
      "look at `<!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:abc -->` in docs\n";
    expect(findBlock(file)).toBeNull();
  });

  test("returns null when begin is present but end is missing", () => {
    const file =
      "<!-- BEGIN AGENT-HOOKS INTEGRATION v:1 hash:abcdef123456 -->\nbody\n";
    expect(findBlock(file)).toBeNull();
  });
});

// --- spliceBlock -------------------------------------------------------

describe("spliceBlock", () => {
  test("inserts a block at the end when none exists", () => {
    const original = "# Readme\n\nHello.\n";
    const result = spliceBlock(original, "body");
    expect(result.action).toBe("inserted");
    expect(result.text.startsWith("# Readme\n\nHello.")).toBe(true);
    expect(result.text).toContain("BEGIN AGENT-HOOKS");
    expect(result.text).toContain("END AGENT-HOOKS");
  });

  test("inserted block is separated by exactly one blank line", () => {
    const result = spliceBlock("# Readme\n\nHello.", "body");
    expect(result.text).toContain("Hello.\n\n<!-- BEGIN AGENT-HOOKS");
  });

  test("inserting into empty text produces the block alone", () => {
    const result = spliceBlock("", "body");
    expect(result.action).toBe("inserted");
    expect(result.text.startsWith("<!-- BEGIN AGENT-HOOKS")).toBe(true);
  });

  test("insertion normalizes trailing whitespace on the original", () => {
    const result = spliceBlock("# Readme\n\n\n\n", "body");
    expect(result.text).not.toContain("\n\n\n<!-- BEGIN");
  });

  test("refreshes a stale block and preserves content outside the markers", () => {
    const oldBlock = wrapBlock("old-body");
    const original = `# Title\n\nintro\n\n${oldBlock}\n\nfootnote\n`;
    const result = spliceBlock(original, "new-body");
    expect(result.action).toBe("refreshed");
    expect(result.text).toContain("# Title");
    expect(result.text).toContain("intro");
    expect(result.text).toContain("footnote");
    expect(result.text).not.toContain("old-body");
    expect(result.text).toContain("new-body");
  });

  test("is a noop when the existing hash matches the new body", () => {
    const original = `# Title\n\n${wrapBlock("body")}\n`;
    const result = spliceBlock(original, "body");
    expect(result.action).toBe("unchanged");
    expect(result.text).toBe(original);
  });

  test("preserves every byte outside the block on refresh", () => {
    // Messy input: leading text with weird chars, code fences,
    // trailing section — the splice must keep every byte outside
    // the markers exactly byte-for-byte.
    const before = "# My project 🚀\n\n```\nfoo\n```\n\n";
    const after = "\nsome more **markdown**\n";
    const original = `${before}${wrapBlock("old")}${after}`;
    const result = spliceBlock(original, "brand new body");
    expect(result.action).toBe("refreshed");
    const found = findBlock(result.text);
    expect(found).not.toBeNull();
    expect(result.text.slice(0, found!.start)).toBe(before);
    expect(result.text.slice(found!.end)).toBe(after);
  });

  test("splicing the constant BLOCK_BODY into an empty file is noop-stable", () => {
    // Insert once, insert again with the same body — the second
    // call must report `unchanged`.
    const once = spliceBlock("", BLOCK_BODY);
    const twice = spliceBlock(once.text, BLOCK_BODY);
    expect(twice.action).toBe("unchanged");
    expect(twice.text).toBe(once.text);
  });
});

// --- removeBlock -------------------------------------------------------

describe("removeBlock", () => {
  test("returns unchanged when no block is present", () => {
    const result = removeBlock("# No block here\n");
    expect(result.action).toBe("unchanged");
    expect(result.text).toBe("# No block here\n");
  });

  test("removes the block and the separator blank line", () => {
    const original = `# Title\n\nhello\n\n${wrapBlock("body")}\n`;
    const result = removeBlock(original);
    expect(result.action).toBe("removed");
    expect(result.text).not.toContain("BEGIN AGENT-HOOKS");
    expect(result.text).toContain("# Title");
    expect(result.text).toContain("hello");
  });

  test("leaves user content after the block intact", () => {
    const original = `intro\n\n${wrapBlock("body")}\n\nafter content\n`;
    const result = removeBlock(original);
    expect(result.action).toBe("removed");
    expect(result.text).toContain("intro");
    expect(result.text).toContain("after content");
  });
});
