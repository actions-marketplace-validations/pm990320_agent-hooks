# GitHub Actions

agent-hooks ships a composite GitHub Action and generates a starter
workflow during `init`.

## The composite action

Use it directly in any workflow:

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
        with:
          version: latest        # or pinned: v0.1.2
          config: .config/agent-hooks.yml   # optional
          pipeline: ci           # which pipeline to run
          cache: true            # cache binary across runs
      - run: agent-hooks ci
```

### Inputs

| Input | Default | Description |
|---|---|---|
| `version` | `latest` | Version to install (tag, range, or `latest`) |
| `config` | auto-detect | Path to `agent-hooks.yml` |
| `pipeline` | `ci` | Pipeline to run if `run: true` |
| `cache` | `true` | Toolcache the binary across runs |
| `run` | `false` | Run the pipeline as part of the action itself |

### Outputs

| Output | Description |
|---|---|
| `version` | Resolved version that was installed |
| `binary-path` | Path to the installed binary |
| `exit-code` | Exit code if `run: true` |

### Versioning

Releases tag as `v0.1.2`. A rolling `v1` tag points at the latest
`v1.x.x` release. Pin to `@v1` for automatic patches and minors, or
to `@v0.1.2` for strict pinning.

## Init workflow scaffolding

During `init`, after the config is written, you'll be prompted:

> Create a GitHub Actions workflow that runs `agent-hooks ci`? [Y/n]

### Defaults

- Target file: `.github/workflows/agent-hooks.yml` — avoids
  clobbering an existing `ci.yml` / `test.yml` / `build.yml`
- Triggers: `push` on default branch + `pull_request`
- Runner: `ubuntu-latest` with a commented-out matrix block

### Conflict rules

| Situation | Behavior |
|---|---|
| Target doesn't exist | Write it |
| Target identical | No-op |
| Target differs | Show diff; prompt keep / overwrite / rename / skip; default is rename |
| `--workflow-name ci` chosen and `ci.yml` exists | Same diff prompt as above |
| Any workflow already contains `uses: pm990320/agent-hooks` | Warn + offer to skip |

### Flags

| Flag | Effect |
|---|---|
| `--with-github-actions` | Generate with defaults, ask only on conflict |
| `--no-github-actions` | Skip entirely, don't ask |
| `--workflow-name <name>` | Override the target filename |
| `--dry-run` | Print planned actions without writing |

## Writing your own workflow

If you want full control, skip the scaffold and use the composite
action directly. The action is thin — it downloads the binary,
puts it on PATH, and returns. You decide what to run with it.

```yaml
jobs:
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
      - run: agent-hooks run pre-commit --all

  full:
    runs-on: ubuntu-latest
    needs: fast
    steps:
      - uses: actions/checkout@v4
      - uses: pm990320/agent-hooks@v1
      - run: agent-hooks ci
```
