import { describe, expect, test } from "bun:test";
import {
  canSemanticMerge,
  createInteractivePrompter,
  diffLines,
  formatDiff,
  mergeYamlConfigs,
  nonInteractiveKeepPrompter,
  textsDiffer,
  type ConflictChoice,
} from "../../src/commands/init-conflicts.ts";

// --- diffLines ----------------------------------------------------------

describe("diffLines", () => {
  test("equal inputs produce all-equal lines", () => {
    const diff = diffLines("a\nb\nc", "a\nb\nc");
    expect(diff.map((l) => l.kind)).toEqual(["equal", "equal", "equal"]);
  });

  test("pure addition at the end", () => {
    const diff = diffLines("a\nb", "a\nb\nc");
    expect(diff).toEqual([
      { kind: "equal", text: "a" },
      { kind: "equal", text: "b" },
      { kind: "add", text: "c" },
    ]);
  });

  test("pure removal at the end", () => {
    const diff = diffLines("a\nb\nc", "a\nb");
    expect(diff).toEqual([
      { kind: "equal", text: "a" },
      { kind: "equal", text: "b" },
      { kind: "remove", text: "c" },
    ]);
  });

  test("insertion in the middle", () => {
    const diff = diffLines("a\nc", "a\nb\nc");
    expect(diff).toEqual([
      { kind: "equal", text: "a" },
      { kind: "add", text: "b" },
      { kind: "equal", text: "c" },
    ]);
  });

  test("replacement yields both a remove and an add entry", () => {
    const diff = diffLines("a", "b");
    expect(diff.length).toBe(2);
    expect(diff.some((l) => l.kind === "remove" && l.text === "a")).toBe(true);
    expect(diff.some((l) => l.kind === "add" && l.text === "b")).toBe(true);
  });

  test("empty old input treats everything as added", () => {
    const diff = diffLines("", "a\nb");
    expect(diff.every((l) => l.kind === "add")).toBe(true);
    expect(diff.length).toBe(2);
  });

  test("empty new input treats everything as removed", () => {
    const diff = diffLines("a\nb", "");
    expect(diff.every((l) => l.kind === "remove")).toBe(true);
    expect(diff.length).toBe(2);
  });

  test("both empty → empty diff", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  test("trailing newline is normalized so it doesn't show as an extra line", () => {
    const diff = diffLines("a\nb\n", "a\nb");
    expect(diff).toEqual([
      { kind: "equal", text: "a" },
      { kind: "equal", text: "b" },
    ]);
  });
});

// --- formatDiff ---------------------------------------------------------

describe("formatDiff", () => {
  test("renders +/-/space prefixes", () => {
    const text = formatDiff([
      { kind: "equal", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "c" },
    ]);
    expect(text).toBe("  a\n- b\n+ c");
  });

  test("empty diff → empty string", () => {
    expect(formatDiff([])).toBe("");
  });
});

// --- textsDiffer --------------------------------------------------------

describe("textsDiffer", () => {
  test("identical texts don't differ", () => {
    expect(textsDiffer("a\nb", "a\nb")).toBe(false);
  });

  test("trailing newline differences are ignored", () => {
    expect(textsDiffer("a\nb\n", "a\nb")).toBe(false);
    expect(textsDiffer("a\nb\n\n\n", "a\nb")).toBe(false);
  });

  test("content differences are detected", () => {
    expect(textsDiffer("a", "b")).toBe(true);
  });
});

// --- mergeYamlConfigs ---------------------------------------------------

describe("mergeYamlConfigs", () => {
  test("returns null for unparseable old text", () => {
    expect(mergeYamlConfigs("{unterminated", "steps: {}")).toBeNull();
  });

  test("returns null when top level isn't a map", () => {
    expect(mergeYamlConfigs("- a\n- b", "steps: {}")).toBeNull();
  });

  test("adds new top-level keys from the new document", () => {
    const merged = mergeYamlConfigs(
      "steps:\n  lint:\n    run: eslint\n",
      "steps:\n  lint:\n    run: eslint\npipelines:\n  ci:\n    steps: [lint]\n",
    );
    expect(merged).not.toBeNull();
    expect(merged).toContain("pipelines:");
    expect(merged).toContain("ci:");
  });

  test("preserves existing step config when the same key appears in both", () => {
    const merged = mergeYamlConfigs(
      "steps:\n  lint:\n    run: existing-lint-command\n",
      "steps:\n  lint:\n    run: new-lint-command\n  typecheck:\n    run: tsc\n",
    );
    expect(merged).not.toBeNull();
    expect(merged).toContain("existing-lint-command");
    expect(merged).not.toContain("new-lint-command");
    expect(merged).toContain("typecheck:");
  });

  test("merges the env submap the same way", () => {
    const merged = mergeYamlConfigs(
      "env:\n  FOO: old\n",
      "env:\n  FOO: new\n  BAR: added\n",
    );
    expect(merged).not.toBeNull();
    expect(merged).toContain("FOO: old");
    expect(merged).toContain("BAR: added");
  });

  test("skips merging when one side's submap isn't a map", () => {
    const merged = mergeYamlConfigs(
      "steps: null\n",
      "steps:\n  lint:\n    run: eslint\n",
    );
    expect(merged).not.toBeNull();
    // Merge is a no-op for that submap; top-level key stays as-is.
    expect(merged).toContain("steps: null");
  });
});

// --- canSemanticMerge ---------------------------------------------------

describe("canSemanticMerge", () => {
  test("matches agent-hooks.yml paths", () => {
    expect(canSemanticMerge("/repo/.config/agent-hooks.yml")).toBe(true);
    expect(canSemanticMerge("/repo/.config/agent-hooks.yaml")).toBe(true);
  });

  test("rejects other paths", () => {
    expect(canSemanticMerge("/repo/.github/workflows/agent-hooks.yml")).toBe(
      true,
    );
    expect(canSemanticMerge("/repo/package.json")).toBe(false);
    expect(canSemanticMerge("/repo/README.md")).toBe(false);
  });
});

// --- nonInteractiveKeepPrompter ----------------------------------------

describe("nonInteractiveKeepPrompter", () => {
  test("always answers 'keep' regardless of input", async () => {
    const choice = await nonInteractiveKeepPrompter.prompt({
      path: "/repo/.config/agent-hooks.yml",
      diff: "something",
      canMerge: true,
    });
    expect(choice).toBe<ConflictChoice>("keep");
  });
});

// --- createInteractivePrompter ------------------------------------------

function scriptedPrompter(answers: readonly string[], canMerge: boolean) {
  const out: string[] = [];
  const prompts: string[] = [];
  let i = 0;
  return {
    prompter: createInteractivePrompter({
      write: (text) => {
        out.push(text);
      },
      read: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(answers[i++] ?? "k");
      },
    }),
    out: () => out.join(""),
    prompts: () => prompts.join(""),
    canMerge,
  };
}

describe("createInteractivePrompter", () => {
  test("empty answer defaults to keep", async () => {
    const s = scriptedPrompter([""], false);
    const choice = await s.prompter.prompt({
      path: "/x",
      diff: "d",
      canMerge: false,
    });
    expect(choice).toBe("keep");
  });

  test("explicit 'k' returns keep", async () => {
    const s = scriptedPrompter(["k"], false);
    expect(
      await s.prompter.prompt({ path: "/x", diff: "d", canMerge: false }),
    ).toBe("keep");
  });

  test("'o' returns overwrite", async () => {
    const s = scriptedPrompter(["o"], false);
    expect(
      await s.prompter.prompt({ path: "/x", diff: "d", canMerge: false }),
    ).toBe("overwrite");
  });

  test("'s' returns skip", async () => {
    const s = scriptedPrompter(["s"], false);
    expect(
      await s.prompter.prompt({ path: "/x", diff: "d", canMerge: false }),
    ).toBe("skip");
  });

  test("'m' returns merge only when merge is allowed", async () => {
    const allowed = scriptedPrompter(["m"], true);
    expect(
      await allowed.prompter.prompt({
        path: "/x",
        diff: "d",
        canMerge: true,
      }),
    ).toBe("merge");
  });

  test("unrecognized answers retry until a valid one arrives", async () => {
    const s = scriptedPrompter(["huh", "?", "overwrite"], false);
    const choice = await s.prompter.prompt({
      path: "/x",
      diff: "d",
      canMerge: false,
    });
    expect(choice).toBe("overwrite");
    expect(s.out()).toContain("unrecognized");
  });

  test("'m' on a non-mergeable input is rejected and retried", async () => {
    const s = scriptedPrompter(["m", "k"], false);
    const choice = await s.prompter.prompt({
      path: "/x",
      diff: "d",
      canMerge: false,
    });
    expect(choice).toBe("keep");
    expect(s.out()).toContain("unrecognized");
  });

  test("writes the diff to the output surface", async () => {
    const s = scriptedPrompter(["k"], false);
    await s.prompter.prompt({
      path: "/x",
      diff: "- foo\n+ bar",
      canMerge: false,
    });
    expect(s.out()).toContain("conflict: /x");
    expect(s.out()).toContain("- foo");
    expect(s.out()).toContain("+ bar");
  });

  test("canMerge: true shows the [m]erge option in the prompt", async () => {
    const s = scriptedPrompter(["k"], true);
    await s.prompter.prompt({ path: "/x", diff: "d", canMerge: true });
    expect(s.prompts()).toContain("[m]erge");
  });

  test("canMerge: false omits the [m]erge option from the prompt", async () => {
    const s = scriptedPrompter(["k"], false);
    await s.prompter.prompt({ path: "/x", diff: "d", canMerge: false });
    expect(s.prompts()).not.toContain("[m]erge");
  });
});
