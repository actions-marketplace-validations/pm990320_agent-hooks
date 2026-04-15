import path from "node:path";
import type { Detector, DetectorFragment } from "./types.ts";

export const rustDetector: Detector = {
  name: "rust",
  displayName: "Rust (cargo)",
  async detect(ctx) {
    return ctx.fs.exists(path.join(ctx.cwd, "Cargo.toml"));
  },
  async template(ctx): Promise<DetectorFragment> {
    if (!(await ctx.fs.exists(path.join(ctx.cwd, "Cargo.toml")))) {
      return {};
    }
    return {
      steps: {
        lint: {
          run: "cargo clippy --all-targets -- -D warnings",
          invocation: "project",
          tags: ["fast", "lint"],
          description: "Run cargo clippy with warnings-as-errors",
        },
        fmt: {
          run: "cargo fmt --all -- --check",
          invocation: "project",
          tags: ["fast", "lint"],
          description: "Check formatting with cargo fmt",
        },
        test: {
          run: "cargo test",
          invocation: "project",
          tags: ["fast"],
          description: "Run cargo test",
        },
        build: {
          run: "cargo build",
          invocation: "project",
          tags: ["slow", "build"],
          description: "Build the workspace",
        },
      },
      pipelines: {
        ci: { steps: ["fmt", "lint", "test", "build"] },
        "pre-commit": {
          steps: ["fmt", "lint", "test"],
          parallel: true,
          "exclude-tags": ["slow"],
        },
        "agent-edit": {
          steps: ["fmt", "lint", "test"],
          parallel: true,
          "exclude-tags": ["slow"],
        },
      },
      notes: ["Detected Cargo.toml — scaffolded clippy/fmt/test/build steps."],
    };
  },
};

export const goDetector: Detector = {
  name: "go",
  displayName: "Go",
  async detect(ctx) {
    return ctx.fs.exists(path.join(ctx.cwd, "go.mod"));
  },
  async template(ctx): Promise<DetectorFragment> {
    if (!(await ctx.fs.exists(path.join(ctx.cwd, "go.mod")))) return {};
    return {
      steps: {
        vet: {
          run: "go vet ./...",
          invocation: "project",
          tags: ["fast", "lint"],
          description: "Run go vet",
        },
        fmt: {
          run: "gofmt -l {files}",
          files: "**/*.go",
          tags: ["fast", "lint"],
          description: "Check formatting with gofmt",
        },
        test: {
          run: "go test ./...",
          invocation: "project",
          tags: ["fast"],
          description: "Run go test",
        },
        build: {
          run: "go build ./...",
          invocation: "project",
          tags: ["slow", "build"],
          description: "Build the module",
        },
      },
      pipelines: {
        ci: { steps: ["fmt", "vet", "test", "build"] },
        "pre-commit": {
          steps: ["fmt", "vet", "test"],
          parallel: true,
          "exclude-tags": ["slow"],
        },
        "agent-edit": {
          steps: ["fmt", "vet", "test"],
          parallel: true,
          "exclude-tags": ["slow"],
        },
      },
      notes: ["Detected go.mod — scaffolded fmt/vet/test/build steps."],
    };
  },
};

export const denoDetector: Detector = {
  name: "deno",
  displayName: "Deno",
  async detect(ctx) {
    return (
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.json"))) ||
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.jsonc"))) ||
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.lock")))
    );
  },
  async template(ctx): Promise<DetectorFragment> {
    const present =
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.json"))) ||
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.jsonc"))) ||
      (await ctx.fs.exists(path.join(ctx.cwd, "deno.lock")));
    if (!present) return {};
    return {
      steps: {
        lint: {
          run: "deno lint {files}",
          files: "**/*.{ts,tsx,js,jsx}",
          tags: ["fast", "lint"],
          description: "Run deno lint",
        },
        typecheck: {
          run: "deno check .",
          invocation: "project",
          tags: ["fast"],
          description: "Type-check the project with deno check",
        },
        test: {
          run: "deno test",
          invocation: "project",
          tags: ["fast"],
          description: "Run deno test",
        },
      },
      pipelines: {
        ci: { steps: ["lint", "typecheck", "test"] },
        "pre-commit": { steps: ["lint", "typecheck", "test"], parallel: true },
        "agent-edit": { steps: ["lint", "typecheck", "test"], parallel: true },
      },
      notes: ["Detected Deno config — scaffolded lint/check/test steps."],
    };
  },
};
