# Playwright-Checkpoint integration

[playwright-checkpoint](https://github.com/pm990320/playwright-checkpoint)
captures structured page snapshots during Playwright runs:
screenshots, HTML, accessibility audits, web vitals, console/network
errors, metadata. It's a first-class citizen in agent-hooks because
its output is exactly the kind of rich artifact an agent benefits
from being told to review.

## Detection

agent-hooks considers Playwright-Checkpoint active if any of:

1. `playwright-checkpoint` in `package.json` dependencies
2. An import of `playwright-checkpoint` in test files under `e2e/`,
   `tests/`, `test/`, or `playwright/`
3. `globalTeardown: 'playwright-checkpoint/teardown'` in
   `playwright.config.{ts,js,mjs}`

## Doctor output

When detected:

```
Playwright-Checkpoint:
  ✓ detected via playwright.config.ts globalTeardown
  ✓ report output: ./report/index.html
  ✓ checkpoint artifacts: test-results/checkpoints/
  → agent prompts will suggest reviewing checkpoint artifacts
    after e2e runs
```

When Playwright is detected but Playwright-Checkpoint is not,
doctor promotes it **once** (suppressible):

```
⚠ Playwright detected without playwright-checkpoint
  → playwright-checkpoint captures screenshots, accessibility audits,
    web vitals, and console/network errors per checkpoint during e2e
    runs, giving agents structured artifacts to review after a test
    run instead of just pass/fail exit codes.
  → install with: bun add -d playwright-checkpoint
  → see: https://github.com/pm990320/playwright-checkpoint
```

Suppress with `doctor --quiet` or:

```yaml
doctor:
  suppress: [playwright-checkpoint]
```

## Upgraded default prompts

When Playwright-Checkpoint is detected, the default `e2e`
feedback prompts change from generic to Checkpoint-aware.

### On failure

```
Playwright run failed ({summary}). For each failing spec:

1. Open test-results/html/index.html for the Playwright report.
2. Review the matching checkpoint folder in
   test-results/checkpoints/<spec-name>/ — each checkpoint contains:
     - page.png (screenshot at the checkpoint)
     - axe.json (accessibility audit findings)
     - web-vitals.json (CLS, LCP, FCP, INP, TTFB)
     - console-errors.json (console + page errors since last checkpoint)
     - failed-requests.json (network failures since last checkpoint)
   Check these for regressions that may have caused or contributed
   to the failure beyond the assertion itself.
3. Re-run only the failing specs:
     agent-hooks run e2e --files "<failing-spec-paths>"
```

### On success

```
E2E passed. Playwright-Checkpoint artifacts are in
test-results/checkpoints/ — it's worth a final pass over the
screenshots and axe.json files for any visual regressions or
accessibility issues that didn't trip an assertion. Report:
./report/index.html
```

## Customizing the prompts

The defaults are overridable per step:

```yaml
steps:
  e2e:
    run: playwright test
    tags: [slow, e2e]
    prompts:
      on-failure: |
        Custom failure message with {step}, {summary}, {files}, and
        {artifacts} variables.
      on-success: |
        Custom success message.
```

See [troubleshooting](./troubleshooting.md#agent-feedback-prompts)
for the full template variable list.

## What Playwright-Checkpoint captures

| Collector | Default | Artifact |
|---|---|---|
| `screenshot` | On | `page.png` |
| `html` | On | `page.html` |
| `axe` | On | `axe.json` |
| `web-vitals` | On | `web-vitals.json` |
| `console` | On | `console-errors.json` |
| `network` | On | `failed-requests.json` |
| `metadata` | On | `metadata.json` |
| `aria-snapshot` | Off | `aria-snapshot.json` |
| `dom-stats` | Off | `dom-stats.json` |
| `forms` | Off | `form-state.json` |
| `storage` | Off | `storage-state.json` |
| `network-timing` | Off | `network-timing.json` |

See the
[playwright-checkpoint README](https://github.com/pm990320/playwright-checkpoint)
for the full configuration surface.
