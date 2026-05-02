import { describe, expect, test } from "bun:test";
import {
  biomeDetector,
  hasBiome,
} from "../../../src/integrations/detectors/biome.ts";
import type { DetectorFs } from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (p) => Promise.resolve(p in files),
    read: (p) => {
      if (!(p in files)) return Promise.reject(new Error(`ENOENT ${p}`));
      return Promise.resolve(files[p]!);
    },
  };
}

describe("biomeDetector", () => {
  test("fires when biome.json exists", async () => {
    const fs = memFs({ "/repo/biome.json": "{}" });
    expect(await biomeDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires when biome.jsonc exists", async () => {
    const fs = memFs({ "/repo/biome.jsonc": "{}" });
    expect(await biomeDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires when @biomejs/biome is a dependency", async () => {
    const fs = memFs({
      "/repo/package.json": JSON.stringify({
        devDependencies: { "@biomejs/biome": "^2.0.0" },
      }),
    });
    expect(await hasBiome({ cwd: "/repo", fs })).toBe(true);
  });

  test("does not fire without Biome signals", async () => {
    const fs = memFs({ "/repo/package.json": JSON.stringify({}) });
    expect(await biomeDetector.detect({ cwd: "/repo", fs })).toBe(false);
  });

  test("template emits biome check lint step and lint pipelines", async () => {
    const fs = memFs({ "/repo/biome.json": "{}" });
    const fragment = await biomeDetector.template({ cwd: "/repo", fs });
    const lintRun = fragment.steps?.["lint"]?.run as {
      files?: string;
      project?: string;
    };
    expect(lintRun.files).toBe("biome check {files}");
    expect(lintRun.project).toBe("biome check .");
    expect(fragment.steps?.["lint"]?.files).toContain("jsonc");
    expect(fragment.pipelines?.["ci"]?.steps).toEqual(["lint"]);
    expect(fragment.pipelines?.["agent-edit"]?.steps).toEqual(["lint"]);
  });
});
