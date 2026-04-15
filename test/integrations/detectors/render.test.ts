import { describe, expect, test } from "bun:test";
import YAML from "yaml";
import { ConfigSchema } from "../../../src/config/schema.ts";
import {
  FALLBACK_FRAGMENT,
  renderConfigYaml,
} from "../../../src/integrations/detectors/render.ts";

describe("renderConfigYaml", () => {
  test("includes the schema header line", () => {
    const out = renderConfigYaml(FALLBACK_FRAGMENT);
    expect(out).toContain("yaml-language-server: $schema=");
  });

  test("rendered YAML parses back into a valid agent-hooks config", () => {
    const out = renderConfigYaml(FALLBACK_FRAGMENT);
    const parsed = YAML.parse(out) as Record<string, unknown>;
    const result = ConfigSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  test("includes detector names + notes when present", () => {
    const out = renderConfigYaml({
      steps: { lint: { run: "echo" } },
      pipelines: { ci: { steps: ["lint"] } },
      gitHooks: {},
      detectorNames: ["node-bun"],
      notes: ["Detected bun — scaffolded steps"],
    });
    expect(out).toContain("Detected stacks: node-bun");
    expect(out).toContain("Detected bun — scaffolded steps");
  });

  test("uses the project name when provided", () => {
    const out = renderConfigYaml(
      {
        steps: { lint: { run: "echo" } },
        pipelines: { ci: { steps: ["lint"] } },
        gitHooks: {},
        detectorNames: [],
        notes: [],
      },
      "my-cool-app",
    );
    expect(out).toContain("name: my-cool-app");
  });

  test("omits the git block when no git hooks are configured", () => {
    const out = renderConfigYaml({
      steps: { lint: { run: "echo" } },
      pipelines: { ci: { steps: ["lint"] } },
      gitHooks: {},
      detectorNames: [],
      notes: [],
    });
    const parsed = YAML.parse(out) as Record<string, unknown>;
    expect(parsed["git"]).toBeUndefined();
  });

  test("includes the git block with hooks when present", () => {
    const out = renderConfigYaml({
      steps: { lint: { run: "echo" } },
      pipelines: { "pre-commit": { steps: ["lint"] } },
      gitHooks: { "pre-commit": { pipeline: "pre-commit" } },
      detectorNames: ["node-bun"],
      notes: [],
    });
    const parsed = YAML.parse(out) as {
      git: { hooks: { "pre-commit": { pipeline: string } } };
    };
    expect(parsed.git.hooks["pre-commit"]?.pipeline).toBe("pre-commit");
  });
});
