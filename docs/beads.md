# Beads integration

[Beads](https://github.com/steveyegge/beads) is a lightweight issue
tracker with dependency support. agent-hooks integrates with it to
handle the "forgot to commit beads changes" follow-up commit dance
automatically.

## Detection

Active if either:

- `.beads/` directory exists at repo root
- `beads.enabled: true` in `.config/agent-hooks.yml`

## Features

### Pre-commit staging

Before `pre-commit` runs, agent-hooks can stage any modified files
under `.beads/` so they land in the same commit as the change that
caused them.

```yaml
beads:
  enabled: auto
  pre-commit: stage
```

Values for `pre-commit`:

- `stage` — auto `git add .beads/` changes before the hook
- `warn` — warn if `.beads/` has unstaged changes, don't stage
- `off` — ignore

### Post-sync follow-up commit

After `bd sync`, run:

```
agent-hooks beads post-sync
```

If `bd sync` produced changes, it makes a follow-up commit with a
conventional message (`chore(beads): sync`) and a `[claude]` marker
if running under a coding agent.

Agents can call this at the end of their turn to eliminate the
manual follow-up commit pattern.

### Config

```yaml
beads:
  enabled: auto                  # auto | true | false
  pre-commit: stage               # stage | warn | off
  post-sync: commit               # commit | warn | off
  commit-message: "chore(beads): sync"
  agent-marker: "[claude]"
```

## Commands

```
agent-hooks beads post-sync       # run `bd sync` and commit any .beads/* changes
```

The pre-commit auto-stager is wired into the `pre-commit` git hook
automatically — it runs before the pipeline resolves staged files,
so any `.beads/*` changes land in the same commit as whatever else
you're about to push. It's governed by `beads.pre-commit` in the
config (default `stage`).

## Why this exists

Agents frequently edit `.beads/` files as part of their work but
forget to commit them. This causes a characteristic back-and-forth
where the human reviewer notices the missing commit and pings the
agent to add it. Automating this removes an entire class of
unnecessary churn.
