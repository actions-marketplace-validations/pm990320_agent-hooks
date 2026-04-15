import path from "node:path";
import type {
  Detector,
  DetectorContext,
  DetectorFragment,
} from "./types.ts";

async function hasLock(
  ctx: DetectorContext,
  name: string,
): Promise<boolean> {
  return ctx.fs.exists(path.join(ctx.cwd, name));
}

async function hasPyproject(ctx: DetectorContext): Promise<boolean> {
  return ctx.fs.exists(path.join(ctx.cwd, "pyproject.toml"));
}

function pythonFragment(
  manager: "uv" | "poetry" | "pipenv",
): DetectorFragment {
  const runner =
    manager === "uv"
      ? "uv run"
      : manager === "poetry"
        ? "poetry run"
        : "pipenv run";
  const install =
    manager === "uv"
      ? "uv sync"
      : manager === "poetry"
        ? "poetry install"
        : "pipenv install";
  return {
    steps: {
      lint: {
        run: `${runner} ruff check {files}`,
        files: "**/*.py",
        tags: ["fast", "lint"],
        description: `Lint Python sources with ruff via ${manager}`,
      },
      typecheck: {
        run: `${runner} mypy .`,
        invocation: "project",
        tags: ["fast"],
        description: `Type-check with mypy via ${manager}`,
      },
      test: {
        run: `${runner} pytest`,
        invocation: "project",
        tags: ["fast"],
        description: `Run pytest via ${manager}`,
      },
      "install-deps": {
        run: install,
        invocation: "project",
        description: `Re-install dependencies via ${manager}`,
      },
    },
    pipelines: {
      ci: { steps: ["lint", "typecheck", "test"] },
      "pre-commit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
      },
      "agent-edit": {
        steps: ["lint", "typecheck", "test"],
        parallel: true,
      },
      reinstall: { steps: ["install-deps"] },
    },
    gitHooks: {
      "post-merge": { pipeline: "reinstall" },
      "post-checkout": { pipeline: "reinstall" },
    },
    notes: [
      `Detected Python (${manager}) — scaffolded ruff/mypy/pytest steps plus a post-merge reinstall hook.`,
    ],
  };
}

export const pythonUvDetector: Detector = {
  name: "python-uv",
  displayName: "Python (uv)",
  async detect(ctx) {
    return (
      (await hasLock(ctx, "uv.lock")) ||
      ((await hasPyproject(ctx)) && (await hasLock(ctx, "uv.lock")))
    );
  },
  async template(ctx) {
    if (!(await hasLock(ctx, "uv.lock"))) return {};
    return pythonFragment("uv");
  },
};

export const pythonPoetryDetector: Detector = {
  name: "python-poetry",
  displayName: "Python (poetry)",
  async detect(ctx) {
    return hasLock(ctx, "poetry.lock");
  },
  async template(ctx) {
    if (!(await hasLock(ctx, "poetry.lock"))) return {};
    return pythonFragment("poetry");
  },
};

export const pythonPipenvDetector: Detector = {
  name: "python-pipenv",
  displayName: "Python (pipenv)",
  async detect(ctx) {
    return hasLock(ctx, "Pipfile.lock");
  },
  async template(ctx) {
    if (!(await hasLock(ctx, "Pipfile.lock"))) return {};
    return pythonFragment("pipenv");
  },
};
