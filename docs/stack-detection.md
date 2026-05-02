# Stack detection

`agent-hooks init` scans the repo and scaffolds a config tuned to
what it finds. Detection is additive — multiple templates can
apply to one repo.

## Detectors

| Detector | Signals | Steps added |
|---|---|---|
| `biome` | `biome.json`, `biome.jsonc`, or `@biomejs/biome` / `biome` in `package.json` dependencies | `lint` via `biome check` for JavaScript / TypeScript / JSON / CSS |
| `bun` | `bun.lockb`, `bunfig.toml`, `packageManager: bun@…` | `lint`, `test`, `build`, `typecheck`, `install` — all via `bun run …` |
| `node-npm` | `package-lock.json` | same shape via `npm run …` / `npx` |
| `node-pnpm` | `pnpm-lock.yaml` | `pnpm …` variants |
| `node-yarn` | `yarn.lock` | `yarn …` variants |
| `python-uv` | `uv.lock`, `pyproject.toml` | `uv run ruff check {files}`, `uv run pytest`, `uv sync` |
| `python-poetry` | `poetry.lock` | `poetry run …` variants |
| `rust` | `Cargo.toml` | `cargo clippy`, `cargo test`, `cargo build`, `cargo fmt --check` |
| `go` | `go.mod` | `go vet`, `go test ./...`, `go build ./...`, `gofmt -l` |
| `deno` | `deno.json`, `deno.lock` | `deno lint`, `deno test`, `deno check` |
| `terraform` | `*.tf` anywhere | `terraform fmt -check`, per-directory `terraform validate` |
| `helm` | `Chart.yaml` anywhere | per-chart-root `helm lint`, `helm template` |
| `kube-linter` | `.kube-linter.yaml`, Kubernetes manifests, or `Chart.yaml` | per-directory / per-chart-root `kube-linter lint` |

The Terraform, Helm, and KubeLinter templates use grouped invocation
modes:

- Terraform validation uses `invocation: per-directory` with
  `dir-from: parent` so each module directory is validated once.
- Helm and KubeLinter chart checks use `invocation: per-marker-dir`
  with `marker: Chart.yaml` so each chart root is linted once, while
  vendored nested charts can be skipped with `exclude-ancestors: charts`.

## Auto-wired hooks

Biome detection composes with Node-family package-manager detection. When both
Biome and a Node detector fire, the generated `lint` step uses
`biome check` and the Node detector still contributes typecheck, test,
build, install, and auto-reinstall wiring.

For Node/Bun/pnpm/yarn and Python uv/poetry detectors, `init`
additionally wires a `post-merge` hook that runs the matching
`install` step when `package.json` / the lockfile changed in the
merged range. Same for `post-checkout` and `post-rewrite`.

This kills the "pulled main, forgot to reinstall, tests fail
mysteriously" bug class. Opt out with `--no-auto-reinstall`.

## How fragments merge

Each detector returns a fragment, not a full config. `init` merges
applicable fragments, deduplicates step names (prefixing with the
detector name on collision), and shows the merged config before
writing.

If two detectors contribute a `lint` step, they become
`bun:lint` and `rust:lint`, and you can reference either explicitly
in your pipelines.

## Flags

| Flag | Effect |
|---|---|
| `--template <name>` | Force a specific template, skip detection |
| `--no-templates` | Start from an empty skeleton |
| `--no-auto-reinstall` | Skip the post-merge reinstall hook |

## Test framework detection

In addition to the stack detectors above, `init` scans for common
long-running test frameworks and auto-tags their steps with
`[slow, e2e, browser]` so they're excluded from `pre-commit` and
`agent-edit` pipelines:

- Playwright (`playwright.config.{ts,js,mjs}`)
- Cypress (`cypress.config.{ts,js}`)
- Cucumber (`cucumber.json`, `features/`)
- Selenium / webdriverio (`wdio.conf.{ts,js}`)
- Detox (`.detoxrc.*`)

See [testing](./testing.md) for how tags interact with pipeline
filtering.

## Contributing a detector

Detectors live in `src/integrations/detectors/` and implement:

```ts
interface Detector {
  name: string;
  detect(cwd: string): Promise<boolean>;
  template(cwd: string): Promise<PartialConfig>;
}
```

See [contributing](./contributing.md) for the full walkthrough.
