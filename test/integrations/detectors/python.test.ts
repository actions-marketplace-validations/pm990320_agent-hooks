import { describe, expect, test } from "bun:test";
import {
  pythonPipenvDetector,
  pythonPoetryDetector,
  pythonUvDetector,
} from "../../../src/integrations/detectors/python.ts";
import type { DetectorFs } from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (p) => Promise.resolve(p in files),
    read: (p) =>
      p in files
        ? Promise.resolve(files[p]!)
        : Promise.reject(new Error(`ENOENT ${p}`)),
  };
}

describe("pythonUvDetector", () => {
  test("fires on uv.lock", async () => {
    const fs = memFs({ "/repo/uv.lock": "" });
    expect(await pythonUvDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("fires on pyproject.toml + uv.lock", async () => {
    const fs = memFs({
      "/repo/pyproject.toml": "",
      "/repo/uv.lock": "",
    });
    expect(await pythonUvDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("does not fire on pyproject.toml alone", async () => {
    const fs = memFs({ "/repo/pyproject.toml": "" });
    expect(await pythonUvDetector.detect({ cwd: "/repo", fs })).toBe(false);
  });

  test("template emits ruff/mypy/pytest steps via uv run", async () => {
    const fs = memFs({ "/repo/uv.lock": "" });
    const fragment = await pythonUvDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("uv run ruff check");
    expect(fragment.steps?.["typecheck"]?.run).toContain("uv run mypy");
    expect(fragment.steps?.["test"]?.run).toContain("uv run pytest");
    expect(fragment.steps?.["install-deps"]?.run).toBe("uv sync");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await pythonUvDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});

describe("pythonPoetryDetector", () => {
  test("fires on poetry.lock", async () => {
    const fs = memFs({ "/repo/poetry.lock": "" });
    expect(await pythonPoetryDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template uses poetry run", async () => {
    const fs = memFs({ "/repo/poetry.lock": "" });
    const fragment = await pythonPoetryDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("poetry run ruff check");
    expect(fragment.steps?.["install-deps"]?.run).toBe("poetry install");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await pythonPoetryDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});

describe("pythonPipenvDetector", () => {
  test("fires on Pipfile.lock", async () => {
    const fs = memFs({ "/repo/Pipfile.lock": "" });
    expect(await pythonPipenvDetector.detect({ cwd: "/repo", fs })).toBe(true);
  });

  test("template uses pipenv run", async () => {
    const fs = memFs({ "/repo/Pipfile.lock": "" });
    const fragment = await pythonPipenvDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["lint"]?.run).toContain("pipenv run ruff check");
    expect(fragment.steps?.["install-deps"]?.run).toBe("pipenv install");
  });

  test("template returns empty when not detected", async () => {
    expect(
      await pythonPipenvDetector.template({ cwd: "/repo", fs: memFs({}) }),
    ).toEqual({});
  });
});
