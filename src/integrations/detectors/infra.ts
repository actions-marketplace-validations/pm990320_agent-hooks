import path from "node:path";
import type {
  Detector,
  DetectorContext,
  DetectorFragment,
} from "./types.ts";

const IGNORED_DIRS = new Set([
  ".git",
  ".terraform",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  ".next",
]);

function shouldDescend(relativePath: string): boolean {
  const segmentCount = relativePath === "" ? 0 : relativePath.split("/").length;
  if (segmentCount > 20) return false;
  return path.posix.extname(path.posix.basename(relativePath)) === "";
}

async function hasMatchingFile(
  ctx: DetectorContext,
  predicate: (relativePath: string) => boolean,
): Promise<boolean> {
  if (ctx.fs.list === undefined) return false;

  const pendingDirs = [""];

  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.shift();
    if (relativeDir === undefined) break;

    const absoluteDir = path.join(ctx.cwd, relativeDir);
    const entries = await ctx.fs.list(absoluteDir);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;

      const relativePath = relativeDir === ""
        ? entry
        : path.posix.join(relativeDir, entry);

      if (predicate(relativePath)) return true;

      if (shouldDescend(relativePath)) pendingDirs.push(relativePath);
    }
  }

  return false;
}

async function hasKubeLinterConfig(ctx: DetectorContext): Promise<boolean> {
  return (
    (await ctx.fs.exists(path.join(ctx.cwd, ".kube-linter.yaml"))) ||
    (await ctx.fs.exists(path.join(ctx.cwd, ".kube-linter.yml")))
  );
}

async function hasHelmChart(ctx: DetectorContext): Promise<boolean> {
  return hasMatchingFile(
    ctx,
    (relativePath) => path.posix.basename(relativePath) === "Chart.yaml",
  );
}

async function hasKubernetesManifest(ctx: DetectorContext): Promise<boolean> {
  if (ctx.fs.list === undefined) return false;

  const pendingDirs = [""];
  while (pendingDirs.length > 0) {
    const relativeDir = pendingDirs.shift();
    if (relativeDir === undefined) break;

    const absoluteDir = path.join(ctx.cwd, relativeDir);
    const entries = await ctx.fs.list(absoluteDir);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry)) continue;

      const relativePath = relativeDir === ""
        ? entry
        : path.posix.join(relativeDir, entry);
      const absolutePath = path.join(ctx.cwd, relativePath);

      if (/\.(ya?ml)$/.test(entry) && entry !== "Chart.yaml") {
        try {
          const contents = await ctx.fs.read(absolutePath);
          if (/\bapiVersion\s*:/.test(contents) && /\bkind\s*:/.test(contents)) {
            return true;
          }
        } catch {
          // Directory-like entries fail to read in some in-memory adapters.
        }
      }

      if (shouldDescend(relativePath)) pendingDirs.push(relativePath);
    }
  }

  return false;
}

export const terraformDetector: Detector = {
  name: "terraform",
  displayName: "Terraform",
  async detect(ctx) {
    return hasMatchingFile(ctx, (relativePath) => relativePath.endsWith(".tf"));
  },
  async template(ctx): Promise<DetectorFragment> {
    if (
      !(await hasMatchingFile(
        ctx,
        (relativePath) => relativePath.endsWith(".tf"),
      ))
    ) {
      return {};
    }
    return {
      steps: {
        "terraform-fmt": {
          run: "terraform fmt -check {files}",
          files: "**/*.tf",
          tags: ["fast", "lint"],
          description: "Check Terraform formatting",
        },
        "terraform-validate": {
          run: "terraform -chdir={dir} init -backend=false && terraform -chdir={dir} validate",
          files: "**/*.tf",
          invocation: "per-directory",
          "dir-from": "parent",
          parallel: 4,
          tags: ["fast", "lint"],
          description: "Validate each Terraform module directory",
        },
      },
      pipelines: {
        ci: { steps: ["terraform-fmt", "terraform-validate"] },
        "pre-commit": {
          steps: ["terraform-fmt", "terraform-validate"],
          parallel: true,
        },
        "agent-edit": {
          steps: ["terraform-fmt", "terraform-validate"],
          parallel: true,
        },
      },
      notes: [
        "Detected Terraform files — scaffolded fmt plus per-directory validate.",
      ],
    };
  },
};

export const helmDetector: Detector = {
  name: "helm",
  displayName: "Helm",
  async detect(ctx) {
    return hasMatchingFile(
      ctx,
      (relativePath) => path.posix.basename(relativePath) === "Chart.yaml",
    );
  },
  async template(ctx): Promise<DetectorFragment> {
    if (
      !(await hasMatchingFile(
        ctx,
        (relativePath) => path.posix.basename(relativePath) === "Chart.yaml",
      ))
    ) {
      return {};
    }
    return {
      steps: {
        "helm-lint": {
          run: "helm lint {dir}",
          files: "**/charts/**/*.yaml",
          invocation: "per-marker-dir",
          marker: "Chart.yaml",
          "exclude-ancestors": "charts",
          parallel: 4,
          tags: ["fast", "lint"],
          description: "Lint each Helm chart root",
        },
        "helm-template": {
          run: "helm template {dir}",
          files: "**/charts/**/*.yaml",
          invocation: "per-marker-dir",
          marker: "Chart.yaml",
          "exclude-ancestors": "charts",
          parallel: 4,
          tags: ["fast"],
          description: "Render each Helm chart root",
        },
      },
      pipelines: {
        ci: { steps: ["helm-lint", "helm-template"] },
        "pre-commit": {
          steps: ["helm-lint", "helm-template"],
          parallel: true,
        },
        "agent-edit": {
          steps: ["helm-lint", "helm-template"],
          parallel: true,
        },
      },
      notes: [
        "Detected Helm charts — scaffolded per-marker-dir lint/template steps.",
      ],
    };
  },
};

export const kubeLinterDetector: Detector = {
  name: "kube-linter",
  displayName: "KubeLinter",
  async detect(ctx) {
    return (
      (await hasKubeLinterConfig(ctx)) ||
      (await hasHelmChart(ctx)) ||
      (await hasKubernetesManifest(ctx))
    );
  },
  async template(ctx): Promise<DetectorFragment> {
    const hasConfig = await hasKubeLinterConfig(ctx);
    const hasCharts = await hasHelmChart(ctx);
    const hasManifests = await hasKubernetesManifest(ctx);
    if (!hasConfig && !hasCharts && !hasManifests) return {};

    const steps: Record<string, NonNullable<DetectorFragment["steps"]>[string]> = {};
    const ciSteps: string[] = [];

    if (hasManifests || hasConfig) {
      steps["kube-linter-manifests"] = {
        run: "kube-linter lint {dir}",
        files: "**/*.{yaml,yml}",
        invocation: "per-directory",
        "dir-from": "parent",
        parallel: 4,
        tags: ["fast", "lint", "security"],
        description: "Run KubeLinter once per Kubernetes manifest directory",
      };
      ciSteps.push("kube-linter-manifests");
    }

    if (hasCharts) {
      steps["kube-linter-helm"] = {
        run: "kube-linter lint {dir}",
        files: "**/*.{yaml,yml}",
        invocation: "per-marker-dir",
        marker: "Chart.yaml",
        "exclude-ancestors": "charts",
        parallel: 4,
        tags: ["fast", "lint", "security"],
        description: "Run KubeLinter once per Helm chart root",
      };
      ciSteps.push("kube-linter-helm");
    }

    return {
      steps,
      pipelines: {
        ci: { steps: ciSteps },
        "pre-commit": { steps: ciSteps, parallel: true },
        "agent-edit": { steps: ciSteps, parallel: true },
      },
      notes: [
        "Detected Kubernetes manifests or Helm charts — scaffolded KubeLinter checks.",
      ],
    };
  },
};
