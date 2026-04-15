import YAML from "yaml";
import type { MergedFragment } from "./merge.ts";

/**
 * The minimal fallback scaffold used when no detector fires. Matches
 * today's `STARTER_CONFIG` output.
 */
export const FALLBACK_FRAGMENT: MergedFragment = {
  steps: {
    lint: {
      run: 'echo "configure your linter here"',
      files: "**/*.{ts,tsx,js,jsx}",
    },
    test: {
      run: 'echo "configure your tests here"',
      files: "**/*.{ts,tsx}",
    },
  },
  pipelines: {
    ci: { steps: ["lint", "test"] },
    "pre-commit": { steps: ["lint"] },
  },
  gitHooks: {
    "pre-commit": { pipeline: "pre-commit" },
  },
  detectorNames: [],
  notes: ["No stack detector fired — wrote a minimal skeleton."],
};

/**
 * Render a merged fragment to the YAML document we write at
 * `.config/agent-hooks.yml`. A top comment references the JSON Schema
 * so VS Code picks it up, and each detector's note is included
 * verbatim so users can see why each step exists.
 */
export function renderConfigYaml(
  fragment: MergedFragment,
  name = "my-project",
): string {
  const header = [
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/pm990320/agent-hooks/main/schema.json",
    "",
  ];
  if (fragment.detectorNames.length > 0) {
    header.push(
      `# Detected stacks: ${fragment.detectorNames.join(", ")}`,
    );
  }
  for (const note of fragment.notes) {
    header.push(`# ${note}`);
  }
  if (header.length > 2) header.push("");

  const document: Record<string, unknown> = {
    name,
    steps: fragment.steps,
    pipelines: fragment.pipelines,
  };

  if (Object.keys(fragment.gitHooks).length > 0) {
    document.git = {
      hooks: fragment.gitHooks,
    };
  }

  const yamlText = YAML.stringify(document, { lineWidth: 0 });
  return `${header.join("\n")}${yamlText}`;
}
