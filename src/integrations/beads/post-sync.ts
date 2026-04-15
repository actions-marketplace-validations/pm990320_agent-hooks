import type { ExecFn } from "../../runners/step.ts";

export interface PostSyncOptions {
  readonly cwd: string;
  readonly exec: ExecFn;
  readonly commitMessage: string;
  readonly agentMarker: string;
}

export type PostSyncStatus =
  | "no-changes"
  | "committed"
  | "sync-failed"
  | "commit-failed";

export interface PostSyncResult {
  readonly status: PostSyncStatus;
  readonly exitCode: number;
}

/**
 * Run `bd sync`, then — if it produced any changes under `.beads/` —
 * create a follow-up commit. This removes the usual "agent forgot to
 * commit the beads sync" churn.
 */
export async function runBeadsPostSync(
  options: PostSyncOptions,
): Promise<PostSyncResult> {
  const sync = await options.exec({
    command: "bd sync",
    cwd: options.cwd,
    env: {},
  });
  if (sync.exitCode !== 0) {
    return { status: "sync-failed", exitCode: sync.exitCode };
  }

  // Run a `git status --porcelain` for observability (tests inspect the
  // call log, prod logs it). Exit code is always 0 so we don't branch
  // on it — the commit step below distinguishes "clean" vs "changed".
  await options.exec({
    command: "git status --porcelain -- .beads/",
    cwd: options.cwd,
    env: {},
  });

  const add = await options.exec({
    command: "git add .beads/",
    cwd: options.cwd,
    env: {},
  });
  if (add.exitCode !== 0) {
    return { status: "commit-failed", exitCode: add.exitCode };
  }

  const marker = options.agentMarker ? ` ${options.agentMarker}` : "";
  const commit = await options.exec({
    command: `git commit -m "${options.commitMessage}${marker}" -- .beads/`,
    cwd: options.cwd,
    env: {},
  });
  if (commit.exitCode === 0) {
    return { status: "committed", exitCode: 0 };
  }
  // `git commit` returns 1 when there's nothing to commit. We treat
  // that as "no changes" rather than an error.
  if (commit.exitCode === 1) {
    return { status: "no-changes", exitCode: 0 };
  }
  return { status: "commit-failed", exitCode: commit.exitCode };
}
