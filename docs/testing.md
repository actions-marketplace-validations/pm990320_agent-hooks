# Testing

This doc covers two things that matter for agents:

1. **Keeping long-running tests out of the fast feedback loop** via
   step tags
2. **Targeted E2E** via area maps — running only the specs relevant
   to changed files

## Step tags and short-hook policy

E2E / Playwright / Cypress / integration tests should never run in
pre-commit or agent-edit pipelines by default. They take too long.
But they should run in CI and on explicit `agent-hooks run e2e`.

### Tagging steps

```yaml
steps:
  e2e:
    run: playwright test
    tags: [slow, e2e, browser]
  integration:
    run: vitest run integration/
    tags: [slow, integration]
  test:
    run: vitest run {files}
    tags: [fast, unit]
```

### Filtering pipelines

```yaml
pipelines:
  ci:
    steps: [lint, typecheck, test, e2e, build]
  pre-commit:
    steps: [lint, typecheck, test]
    exclude-tags: [slow]
  agent-edit:
    steps: [lint, typecheck, test]
    exclude-tags: [slow, browser, e2e]
    on-excluded: silent
```

### `on-excluded` behavior

| Value | Effect |
|---|---|
| `silent` *(default for agent-edit)* | Excluded steps invisible — clean, fast output |
| `warn` *(default for pre-commit)* | Excluded steps shown as `SKIPPED (tag: slow)` |

## Area maps — targeted E2E

Area maps let you run only the E2E specs relevant to the files that
changed, without writing a dependency tracker.

```yaml
steps:
  e2e:
    run:
      files: playwright test {files}
      project: playwright test
    files: "e2e/**/*.spec.ts"
    areas:
      auth:
        when: "src/auth/**"
        run: "e2e/auth/**/*.spec.ts"
      checkout:
        when: "src/checkout/**"
        run:
          - "e2e/checkout/**/*.spec.ts"
          - "e2e/payment/**/*.spec.ts"
      shell:
        when: ["src/layout/**", "src/nav/**", "app.tsx"]
        run: "e2e/smoke/**/*.spec.ts"
    unmatched: skip
```

### How it works

1. Incoming file list intersects each area's `when:` glob
2. For every matching area, its `run:` specs are added to the target
   set
3. The deduplicated set becomes `{files}` for the step's command
4. If nothing matches, `unmatched:` controls the fallback

### `unmatched` values

| Value | Effect |
|---|---|
| `skip` *(default)* | Don't run — print "no areas matched" in yellow |
| `all` | Run the `project` variant — the full suite |
| `smoke` | Run the area named `smoke` if defined — a fast safety net |

### Why globs, not AST analysis

We deliberately don't parse imports or track dependencies. Area maps
are 6 lines of YAML; import tracking is a full-time maintenance
burden for a tool that doesn't know about your framework.

If you need import-level precision, your test runner probably has it
(`vitest --related`, Jest `--findRelatedTests`) — use `run.files`
to wire it into an agent-hooks step directly.

## Fast defaults

Out of the box, stack detection auto-configures:

- Unit test step (`vitest` / `jest` / `bun test` / `pytest`) → tagged `fast`
- E2E test step (`playwright` / `cypress` / `cucumber`) → tagged `slow, e2e, browser`
- `pre-commit` excludes `slow`
- `agent-edit` excludes `slow, browser, e2e`
- `ci` includes everything
- Optional `pre-push` pipeline includes e2e (commented out by default)

## Doctor output

`agent-hooks doctor` surfaces detected-but-unconfigured frameworks:

```
Long-running test categories detected:
  ✓ playwright   tagged [slow, e2e, browser]
                 excluded from: pre-commit, agent-edit
                 included in:   ci
  ⚠ cypress      detected in cypress.config.ts but no step references it
                 → run `agent-hooks init --add-step cypress` to scaffold
```
