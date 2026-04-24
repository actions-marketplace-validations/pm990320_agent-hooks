import { describe, expect, test } from "bun:test";
import {
  helmDetector,
  kubeLinterDetector,
  terraformDetector,
} from "../../../src/integrations/detectors/infra.ts";
import type { DetectorFs } from "../../../src/integrations/detectors/types.ts";

function memFs(files: Record<string, string>): DetectorFs {
  return {
    exists: (filePath) => Promise.resolve(filePath in files),
    read: (filePath) => {
      const contents = files[filePath];
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`ENOENT ${filePath}`));
    },
    list: (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const entries = new Set<string>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const [entry] = rest.split("/");
        if (entry) entries.add(entry);
      }
      return Promise.resolve([...entries]);
    },
  };
}

describe("terraformDetector", () => {
  test("fires on nested Terraform files and emits per-directory validate", async () => {
    const fs = memFs({ "/repo/infra/dev/main.tf": "" });
    expect(await terraformDetector.detect({ cwd: "/repo", fs })).toBe(true);

    const fragment = await terraformDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["terraform-validate"]?.invocation).toBe(
      "per-directory",
    );
    expect(fragment.steps?.["terraform-validate"]?.["dir-from"]).toBe(
      "parent",
    );
    expect(fragment.steps?.["terraform-validate"]?.parallel).toBe(4);
  });
});

describe("helmDetector", () => {
  test("fires on Chart.yaml and emits per-marker-dir lint", async () => {
    const fs = memFs({ "/repo/charts/app/Chart.yaml": "name: app\n" });
    expect(await helmDetector.detect({ cwd: "/repo", fs })).toBe(true);

    const fragment = await helmDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["helm-lint"]?.invocation).toBe("per-marker-dir");
    expect(fragment.steps?.["helm-lint"]?.marker).toBe("Chart.yaml");
    expect(fragment.steps?.["helm-lint"]?.["exclude-ancestors"]).toBe(
      "charts",
    );
  });
});

describe("kubeLinterDetector", () => {
  test("fires on kube-linter config and emits manifest directory pattern", async () => {
    const fs = memFs({ "/repo/.kube-linter.yaml": "" });
    expect(await kubeLinterDetector.detect({ cwd: "/repo", fs })).toBe(true);

    const fragment = await kubeLinterDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["kube-linter-manifests"]?.run).toBe(
      "kube-linter lint {dir}",
    );
    expect(fragment.steps?.["kube-linter-manifests"]?.invocation).toBe(
      "per-directory",
    );
  });

  test("fires on Kubernetes manifest content", async () => {
    const fs = memFs({
      "/repo/k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
    });
    expect(await kubeLinterDetector.detect({ cwd: "/repo", fs })).toBe(true);

    const fragment = await kubeLinterDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["kube-linter-manifests"]?.parallel).toBe(4);
  });

  test("adds Helm chart root pattern when Chart.yaml is present", async () => {
    const fs = memFs({
      "/repo/charts/app/Chart.yaml": "name: app\n",
      "/repo/charts/app/templates/deploy.yaml":
        "apiVersion: apps/v1\nkind: Deployment\n",
    });
    const fragment = await kubeLinterDetector.template({ cwd: "/repo", fs });
    expect(fragment.steps?.["kube-linter-helm"]?.invocation).toBe(
      "per-marker-dir",
    );
    expect(fragment.steps?.["kube-linter-helm"]?.marker).toBe("Chart.yaml");
  });
});
