import { describe, expect, test } from "bun:test";
import {
  parseCommitMessageSkips,
  parseSkipEnvValue,
  resolveSkipDirectives,
} from "../../src/runners/skip-directives.ts";

describe("parseCommitMessageSkips", () => {
  test("returns empty when no tags present", () => {
    const result = parseCommitMessageSkips("regular commit");
    expect(result.skip.size).toBe(0);
    expect(result.skipAll).toBe(false);
  });

  test("[skip agent-hooks] sets skipAll", () => {
    const result = parseCommitMessageSkips("fix: thing\n\n[skip agent-hooks]");
    expect(result.skipAll).toBe(true);
  });

  test("[skip ci] sets skipAll", () => {
    expect(parseCommitMessageSkips("[skip ci]").skipAll).toBe(true);
  });

  test("[skip lint] adds lint to the skip set", () => {
    const result = parseCommitMessageSkips("fix: thing\n\n[skip lint]");
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skipAll).toBe(false);
  });

  test("[skip lint,test] adds both", () => {
    const result = parseCommitMessageSkips("[skip lint,test]");
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skip.has("test")).toBe(true);
  });

  test("[skip lint test] (space-delimited) also works", () => {
    const result = parseCommitMessageSkips("[skip lint test]");
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skip.has("test")).toBe(true);
  });

  test("[agent-hooks skip lint] adds lint to skip set", () => {
    const result = parseCommitMessageSkips("[agent-hooks skip lint]");
    expect(result.skip.has("lint")).toBe(true);
  });

  test("bare [agent-hooks skip] sets skipAll", () => {
    const result = parseCommitMessageSkips("[agent-hooks skip]");
    expect(result.skipAll).toBe(true);
  });

  test("multiple tags compose", () => {
    const result = parseCommitMessageSkips(
      "[skip lint] some text [skip test]",
    );
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skip.has("test")).toBe(true);
    expect(result.matches.length).toBe(2);
  });

  test("[skip all] is treated as skipAll", () => {
    expect(parseCommitMessageSkips("[skip all]").skipAll).toBe(true);
  });
});

describe("parseSkipEnvValue", () => {
  test("empty value yields no skips", () => {
    expect(parseSkipEnvValue("").skip.size).toBe(0);
    expect(parseSkipEnvValue("   ").skipAll).toBe(false);
  });

  test("'1' / 'true' / 'yes' / 'all' set skipAll", () => {
    expect(parseSkipEnvValue("1").skipAll).toBe(true);
    expect(parseSkipEnvValue("true").skipAll).toBe(true);
    expect(parseSkipEnvValue("yes").skipAll).toBe(true);
    expect(parseSkipEnvValue("all").skipAll).toBe(true);
  });

  test("comma-separated list adds entries", () => {
    const result = parseSkipEnvValue("lint, test");
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skip.has("test")).toBe(true);
    expect(result.skipAll).toBe(false);
  });
});

describe("resolveSkipDirectives", () => {
  test("returns empty sets when nothing is configured", () => {
    const result = resolveSkipDirectives({});
    expect(result.skip.size).toBe(0);
    expect(result.only.size).toBe(0);
    expect(result.skipAll).toBe(false);
  });

  test("CLI --skip layer", () => {
    const result = resolveSkipDirectives({ cliSkip: ["lint", "test"] });
    expect(result.skip.has("lint")).toBe(true);
    expect(result.skip.has("test")).toBe(true);
    expect(result.sources[0]?.from).toEqual({ kind: "cli" });
  });

  test("CLI --only layer", () => {
    const result = resolveSkipDirectives({ cliOnly: ["lint"] });
    expect(result.only.has("lint")).toBe(true);
  });

  test("AGENT_HOOKS_SKIP env adds to skip set", () => {
    const result = resolveSkipDirectives({
      env: { AGENT_HOOKS_SKIP: "lint,test" },
    });
    expect(result.skip.size).toBe(2);
    expect(result.sources[0]?.from).toEqual({
      kind: "env",
      name: "AGENT_HOOKS_SKIP",
    });
  });

  test("AGENT_HOOKS_SKIP=1 sets skipAll", () => {
    const result = resolveSkipDirectives({
      env: { AGENT_HOOKS_SKIP: "1" },
    });
    expect(result.skipAll).toBe(true);
  });

  test("AGENT_HOOKS_ONLY env adds to only set", () => {
    const result = resolveSkipDirectives({
      env: { AGENT_HOOKS_ONLY: "lint,test" },
    });
    expect(result.only.size).toBe(2);
  });

  test("commit message [skip agent-hooks] sets skipAll", () => {
    const result = resolveSkipDirectives({
      commitMessage: "fix: bug\n\n[skip agent-hooks]",
    });
    expect(result.skipAll).toBe(true);
  });

  test("commit message [skip lint] adds lint to skip set", () => {
    const result = resolveSkipDirectives({
      commitMessage: "[skip lint]",
    });
    expect(result.skip.has("lint")).toBe(true);
    expect(result.sources[0]?.from).toEqual({
      kind: "commit-message",
      tag: "lint",
    });
  });

  test("layers compose: CLI + env + commit message", () => {
    const result = resolveSkipDirectives({
      cliSkip: ["a"],
      env: { AGENT_HOOKS_SKIP: "b", AGENT_HOOKS_ONLY: "x,y" },
      commitMessage: "[skip c]",
    });
    expect(result.skip.has("a")).toBe(true);
    expect(result.skip.has("b")).toBe(true);
    expect(result.skip.has("c")).toBe(true);
    expect(result.only.has("x")).toBe(true);
    expect(result.only.has("y")).toBe(true);
  });
});
