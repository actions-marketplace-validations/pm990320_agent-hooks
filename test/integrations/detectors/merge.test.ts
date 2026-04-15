import { describe, expect, test } from "bun:test";
import { mergeDetectors } from "../../../src/integrations/detectors/merge.ts";
import {
  DETECTORS,
  getDetector,
  listDetectorNames,
} from "../../../src/integrations/detectors/registry.ts";
import type {
  Detector,
  DetectorFs,
} from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (p) => Promise.resolve(p in files),
    read: (p) =>
      p in files
        ? Promise.resolve(files[p]!)
        : Promise.reject(new Error(`ENOENT ${p}`)),
  };
}

describe("registry", () => {
  test("DETECTORS contains all expected stack detectors", () => {
    const names = DETECTORS.map((d) => d.name);
    expect(names).toContain("node-bun");
    expect(names).toContain("node-pnpm");
    expect(names).toContain("node-yarn");
    expect(names).toContain("node-npm");
    expect(names).toContain("python-uv");
    expect(names).toContain("python-poetry");
    expect(names).toContain("python-pipenv");
    expect(names).toContain("rust");
    expect(names).toContain("go");
    expect(names).toContain("deno");
  });

  test("getDetector returns the detector by name", () => {
    expect(getDetector("python-uv")).not.toBeNull();
  });

  test("getDetector returns null for unknown names", () => {
    expect(getDetector("nonsense")).toBeNull();
  });

  test("listDetectorNames returns all names", () => {
    expect(listDetectorNames().length).toBe(DETECTORS.length);
  });
});

describe("mergeDetectors", () => {
  test("returns an empty fragment when no detectors fire", async () => {
    const merged = await mergeDetectors({ cwd: "/repo", fs: memFs({}) });
    expect(merged.detectorNames).toEqual([]);
    expect(merged.steps).toEqual({});
    expect(merged.pipelines).toEqual({});
  });

  test("merges a single bun detector fragment", async () => {
    const merged = await mergeDetectors({
      cwd: "/repo",
      fs: memFs({ "/repo/bun.lockb": "" }),
    });
    expect(merged.detectorNames).toEqual(["node-bun"]);
    expect(Object.keys(merged.steps)).toContain("lint");
    expect(merged.gitHooks["post-merge"]?.pipeline).toBe("reinstall");
  });

  test("collisions get prefixed with the later detector name", async () => {
    // Both rust and go contribute fmt/test/build steps. With registry
    // order (rust before go), go's collisions should become go:<name>.
    const merged = await mergeDetectors({
      cwd: "/repo",
      fs: memFs({
        "/repo/Cargo.toml": "",
        "/repo/go.mod": "",
      }),
    });
    expect(merged.detectorNames).toEqual(["rust", "go"]);
    // rust's fmt/test/build keep their names.
    expect(merged.steps["fmt"]?.run).toContain("cargo fmt");
    expect(merged.steps["test"]?.run).toContain("cargo test");
    // go's collisions get prefixed.
    expect(merged.steps["go:fmt"]?.run).toContain("gofmt");
    expect(merged.steps["go:test"]?.run).toContain("go test");
    expect(merged.steps["go:build"]?.run).toContain("go build");
    // go's `vet` is unique so it stays unprefixed.
    expect(merged.steps["vet"]?.run).toContain("go vet");
  });

  test("pipelines are unioned with order preserved + dedup", async () => {
    // Both bun and rust contribute to the `ci` pipeline. The merged
    // version should contain steps from both.
    const merged = await mergeDetectors({
      cwd: "/repo",
      fs: memFs({
        "/repo/bun.lockb": "",
        "/repo/Cargo.toml": "",
      }),
    });
    expect(merged.pipelines["ci"]?.steps.length).toBeGreaterThan(4);
  });

  test("uses a custom detector list when provided", async () => {
    const fakeDetector: Detector = {
      name: "fake",
      displayName: "Fake",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { x: { run: "echo x" } },
          pipelines: { ci: { steps: ["x"] } },
          notes: ["fake fired"],
        }),
    };
    const merged = await mergeDetectors(
      { cwd: "/repo", fs: memFs({}) },
      [fakeDetector],
    );
    expect(merged.detectorNames).toEqual(["fake"]);
    expect(merged.notes).toContain("fake fired");
  });

  test("git hook collisions: first detector wins", async () => {
    const a: Detector = {
      name: "a",
      displayName: "A",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          gitHooks: { "post-merge": { pipeline: "from-a" } },
        }),
    };
    const b: Detector = {
      name: "b",
      displayName: "B",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          gitHooks: { "post-merge": { pipeline: "from-b" } },
        }),
    };
    const merged = await mergeDetectors(
      { cwd: "/repo", fs: memFs({}) },
      [a, b],
    );
    expect(merged.gitHooks["post-merge"]?.pipeline).toBe("from-a");
  });

  test("merges exclude-tags as a union when pipelines collide", async () => {
    const a: Detector = {
      name: "a",
      displayName: "A",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { x: { run: "x" } },
          pipelines: {
            ci: { steps: ["x"], "exclude-tags": ["slow"] },
          },
        }),
    };
    const b: Detector = {
      name: "b",
      displayName: "B",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { y: { run: "y" } },
          pipelines: {
            ci: { steps: ["y"], "exclude-tags": ["browser"] },
          },
        }),
    };
    const merged = await mergeDetectors(
      { cwd: "/repo", fs: memFs({}) },
      [a, b],
    );
    const tags = [...(merged.pipelines["ci"]?.["exclude-tags"] ?? [])].sort();
    expect(tags).toEqual(["browser", "slow"]);
  });

  test("preserves parallel flag from first contributor when both define it", async () => {
    const a: Detector = {
      name: "a",
      displayName: "A",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { x: { run: "x" } },
          pipelines: { p: { steps: ["x"], parallel: true } },
        }),
    };
    const b: Detector = {
      name: "b",
      displayName: "B",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { y: { run: "y" } },
          pipelines: { p: { steps: ["y"], parallel: false } },
        }),
    };
    const merged = await mergeDetectors(
      { cwd: "/repo", fs: memFs({}) },
      [a, b],
    );
    expect(merged.pipelines["p"]?.parallel).toBe(true);
  });

  test("propagates parallel from second contributor when first omitted it", async () => {
    const a: Detector = {
      name: "a",
      displayName: "A",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { x: { run: "x" } },
          pipelines: { p: { steps: ["x"] } },
        }),
    };
    const b: Detector = {
      name: "b",
      displayName: "B",
      detect: () => Promise.resolve(true),
      template: () =>
        Promise.resolve({
          steps: { y: { run: "y" } },
          pipelines: { p: { steps: ["y"], parallel: true } },
        }),
    };
    const merged = await mergeDetectors(
      { cwd: "/repo", fs: memFs({}) },
      [a, b],
    );
    expect(merged.pipelines["p"]?.parallel).toBe(true);
  });
});
