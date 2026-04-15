import { describe, expect, test } from "bun:test";
import {
  denoDetector,
  goDetector,
  rustDetector,
} from "../../../src/integrations/detectors/rust-go-deno.ts";
import type { DetectorFs } from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (p) => Promise.resolve(p in files),
    read: () => Promise.reject(new Error("unused")),
  };
}

describe("rustDetector", () => {
  test("fires on Cargo.toml", async () => {
    const fs = memFs({ "/repo/Cargo.toml": "" });
    expect(await rustDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template emits clippy/fmt/test/build", async () => {
    const fs = memFs({ "/repo/Cargo.toml": "" });
    const fragment = await rustDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("cargo clippy");
    expect(fragment.steps?.["fmt"]?.run).toContain("cargo fmt");
    expect(fragment.steps?.["test"]?.run).toContain("cargo test");
    expect(fragment.steps?.["build"]?.run).toContain("cargo build");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await rustDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});

describe("goDetector", () => {
  test("fires on go.mod", async () => {
    const fs = memFs({ "/repo/go.mod": "" });
    expect(await goDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template emits vet/fmt/test/build", async () => {
    const fs = memFs({ "/repo/go.mod": "" });
    const fragment = await goDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["vet"]?.run).toContain("go vet");
    expect(fragment.steps?.["fmt"]?.run).toContain("gofmt");
    expect(fragment.steps?.["test"]?.run).toContain("go test");
    expect(fragment.steps?.["build"]?.run).toContain("go build");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await goDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});

describe("denoDetector", () => {
  test("fires on deno.json", async () => {
    const fs = memFs({ "/repo/deno.json": "" });
    expect(await denoDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires on deno.jsonc", async () => {
    const fs = memFs({ "/repo/deno.jsonc": "" });
    expect(await denoDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires on deno.lock alone", async () => {
    const fs = memFs({ "/repo/deno.lock": "" });
    expect(await denoDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template emits deno lint/check/test", async () => {
    const fs = memFs({ "/repo/deno.json": "" });
    const fragment = await denoDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("deno lint");
    expect(fragment.steps?.["typecheck"]?.run).toContain("deno check");
    expect(fragment.steps?.["test"]?.run).toContain("deno test");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await denoDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});
