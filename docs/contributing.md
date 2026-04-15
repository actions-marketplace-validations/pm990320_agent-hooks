# Contributing

agent-hooks is deliberately designed to be forkable and extensible.
If you're adding a new agent, detector, or reporter, the ceremony
should be minimal.

## Development setup

```bash
git clone https://github.com/pm990320/agent-hooks
cd agent-hooks
bun install
bun test
bun run lint
bun run typecheck
bun run build
```

All of the above must pass before you submit a PR. 100% unit test
coverage is enforced on `src/`.

## Conventional commits

We use Release Please for automated releases, which requires
[Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` or `BREAKING CHANGE:` → major bump
- `docs:`, `chore:`, `test:`, `refactor:` → no release impact

## Adding a new agent integration

Two files, ~100 lines total.

### 1. Installer (`src/integrations/agents/<name>/index.ts`)

```ts
import type { AgentIntegration, InstallResult } from "../types.ts";

export const myAgent: AgentIntegration = {
  name: "my-agent",

  async detect(cwd) {
    return Bun.file(`${cwd}/.my-agent/config.json`).exists();
  },

  async install(config, cwd) {
    // Write the agent's native settings file so its hooks call
    // `agent-hooks hook my-agent <hook-name>`.
    return { filesWritten: ["..."], conflicts: [] };
  },

  async uninstall(cwd) {
    // Remove hooks we added.
  },
};
```

### 2. Handlers (`src/hooks/<name>/`)

```
src/hooks/my-agent/
├── index.ts            ← registry + input parser
├── on-edit.ts          ← or whatever hook names the agent uses
└── on-stop.ts
```

Each handler reads the agent's native input (stdin JSON, env vars,
args), normalizes to `{ files, tool, event }`, and calls the shared
dispatch helper:

```ts
import { dispatchHook } from "../dispatch.ts";

export async function onEdit(input: MyAgentInput): Promise<number> {
  return dispatchHook({
    agent: "my-agent",
    hookName: "OnEdit",
    files: input.edited_files,
    tool: input.tool_name,
    event: input.event_type,
  });
}
```

### 3. Register

Add your agent to the registry in `src/integrations/agents/index.ts`
and `src/hooks/index.ts`. Add tests under `test/hooks/<name>/`.

### 4. Document

Add a section to [agent-integration](./agent-integration.md) with
the copy-paste config snippet users will need.

## Adding a stack detector

One file (`src/integrations/detectors/<name>.ts`):

```ts
import type { Detector } from "./types.ts";

export const myStack: Detector = {
  name: "my-stack",

  async detect(cwd) {
    return Bun.file(`${cwd}/my-stack.config`).exists();
  },

  async template(cwd) {
    return {
      steps: {
        lint: { run: "my-stack lint {files}", files: "**/*.my" },
        test: { run: "my-stack test" },
      },
    };
  },
};
```

Add to the registry in `src/integrations/detectors/index.ts`.
Add a fixture repo under `test/fixtures/<name>/` and an e2e test
that runs `agent-hooks init` against it.

## Adding an invocation mode

1. Add the enum value to `src/runners/step.ts`
2. Add the case to the command builder
3. Document it in [pipelines-and-steps](./pipelines-and-steps.md)
4. Add tests covering the new mode + empty-list behavior

## Testing

- Unit tests: `bun test`
- Lint: `bun run lint`
- Typecheck: `bun run typecheck`
- Binary smoke test: `bun run build && ./bin/agent-hooks --version`

All four must pass in CI before merge.

## Releasing

Releases are automated via Release Please:

1. Merge conventional commits to `main`
2. Release Please opens a "chore(release): x.y.z" PR
3. Merging the release PR creates a GitHub Release and builds +
   attaches platform binaries as release assets
4. The rolling `v1` tag advances to the new release

No manual version bumps, no manual CHANGELOG edits.
