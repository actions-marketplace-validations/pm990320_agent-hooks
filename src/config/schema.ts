import { z } from "zod";

// --- Primitives ----------------------------------------------------------

const NonEmptyString = z.string().min(1);

const StringOrArray = z.union([NonEmptyString, z.array(NonEmptyString).min(1)]);

// --- Step.run ------------------------------------------------------------
//
// Two forms per PLAN §5.4a:
//   1. Plain string: single command, used for both file and project scopes.
//   2. Object with `files:` and/or `project:` variants.

const RunVariants = z
  .object({
    files: NonEmptyString.optional(),
    project: NonEmptyString.optional(),
  })
  .refine((v) => v.files !== undefined || v.project !== undefined, {
    message: "run: object form must define at least one of `files` or `project`",
  });

const Run = z.union([NonEmptyString, RunVariants]);

// --- Invocation modes (PLAN §5.4) ----------------------------------------

const InvocationMode = z.enum([
  "args",
  "per-file",
  "stdin",
  "xargs",
  "glob",
  "project",
]);

// --- Preflight requirements (PLAN §5.6.1) --------------------------------

const RequireCheck = z.union([
  z.object({ command: NonEmptyString }),
  z.object({ path: NonEmptyString }),
  z.object({ file: NonEmptyString }),
  z.object({ env: NonEmptyString }),
  z.object({ "node-modules": z.literal(true) }),
]);

const OnMissing = z.enum(["warn", "warn-skip", "skip", "fail"]);

// --- Change gates (PLAN §5.6a) -------------------------------------------

const WhenChangedSchema = z
  .object({
    paths: StringOrArray,
    since: z.enum(["head", "merge-base", "last-run"]).default("head"),
  })
  .strict();

// --- Area maps (PLAN §5.7) -----------------------------------------------

const Area = z.object({
  when: StringOrArray,
  run: StringOrArray,
});

const Unmatched = z.enum(["skip", "all", "smoke"]);

// --- Prompt templates (PLAN §6a.3) ---------------------------------------

const StepPrompts = z
  .object({
    "on-success": NonEmptyString.optional(),
    "on-failure": NonEmptyString.optional(),
  })
  .strict();

// --- Step ----------------------------------------------------------------

export const StepSchema = z
  .object({
    run: Run,
    files: NonEmptyString.optional(),
    fix: NonEmptyString.optional(),
    fallback: NonEmptyString.optional(),
    scope: z.enum(["project", "files"]).optional(),
    invocation: InvocationMode.default("args"),
    chunk: z.number().int().positive().optional(),
    parallel: z.number().int().positive().optional(),
    tags: z.array(NonEmptyString).default([]),
    requires: z.array(RequireCheck).default([]),
    "on-missing": OnMissing.optional(),
    artifacts: z.array(NonEmptyString).default([]),
    areas: z.record(NonEmptyString, Area).optional(),
    unmatched: Unmatched.optional(),
    "when-changed": WhenChangedSchema.optional(),
    prompts: StepPrompts.optional(),
    env: z.record(NonEmptyString, NonEmptyString).optional(),
    description: NonEmptyString.optional(),
    /**
     * Hard upper bound on how long a single step invocation may take,
     * in milliseconds. 0 disables the timeout (the default). When the
     * limit is reached, the runner sends SIGTERM, waits briefly, then
     * SIGKILL, and returns a synthetic non-zero exit code. The reason
     * is surfaced in the step summary as "timed out after Xms".
     */
    "timeout-ms": z.number().int().nonnegative().default(0),
  })
  .strict();

// --- Pipeline ------------------------------------------------------------

export const PipelineSchema = z
  .object({
    steps: z.array(NonEmptyString).min(1),
    parallel: z.boolean().default(false),
    "exclude-tags": z.array(NonEmptyString).default([]),
    "include-tags": z.array(NonEmptyString).default([]),
    "on-excluded": z.enum(["silent", "warn"]).optional(),
    "continue-on-error": z.boolean().default(false),
    description: NonEmptyString.optional(),
  })
  .strict();

// --- Git hook installer --------------------------------------------------

/**
 * The full set of client-side git hook names we're willing to wire up.
 * Server-side hooks (pre-receive, update, post-receive, …) are excluded
 * because agent-hooks is a local dev tool — it doesn't belong on a server.
 */
export const GIT_HOOK_NAMES = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "post-rewrite",
  "pre-auto-gc",
  "sendemail-validate",
  "fsmonitor-watchman",
  "post-index-change",
] as const;

export type GitHookName = (typeof GIT_HOOK_NAMES)[number];

const GitHookRule = z
  .object({
    pipeline: NonEmptyString,
    "if-missing": OnMissing.optional(),
  })
  .strict();

const GitHooksMap = z
  .object(
    Object.fromEntries(
      GIT_HOOK_NAMES.map((name) => [name, GitHookRule.optional()]),
    ),
  )
  .strict();

const GitSchema = z
  .object({
    enabled: z.union([z.literal("auto"), z.boolean()]).default("auto"),
    hooks: GitHooksMap.optional(),
  })
  .strict();

// --- Beads integration ---------------------------------------------------

const BeadsSchema = z
  .object({
    enabled: z.union([z.literal("auto"), z.boolean()]).default("auto"),
    "pre-commit": z.enum(["stage", "warn", "off"]).default("stage"),
    "post-sync": z.enum(["commit", "warn", "off"]).default("commit"),
    "commit-message": NonEmptyString.default("chore(beads): sync"),
    "agent-marker": NonEmptyString.default("[claude]"),
  })
  .strict();

// --- Agents (PLAN §4.5 / §6) ---------------------------------------------

const AgentHookRule = z
  .object({
    matcher: NonEmptyString.optional(),
    pipeline: NonEmptyString,
  })
  .strict();

const AgentConfig = z
  .object({
    enabled: z.union([z.literal("auto"), z.boolean()]).default("auto"),
    hooks: z.record(NonEmptyString, z.array(AgentHookRule)).optional(),
  })
  .strict();

// --- Install (postinstall wiring, PLAN §4.4a) ----------------------------

const InstallSchema = z
  .object({
    postinstall: z.enum(["auto", "managed", "off"]).default("auto"),
  })
  .strict();

// --- Doctor --------------------------------------------------------------

const DoctorSchema = z
  .object({
    suppress: z.array(NonEmptyString).default([]),
  })
  .strict();

// --- Root ----------------------------------------------------------------

export const ConfigSchema = z
  .object({
    $schema: NonEmptyString.optional(),
    name: NonEmptyString.optional(),
    steps: z.record(NonEmptyString, StepSchema).default({}),
    pipelines: z.record(NonEmptyString, PipelineSchema).default({}),
    git: GitSchema.optional(),
    beads: BeadsSchema.optional(),
    agents: z.record(NonEmptyString, AgentConfig).optional(),
    env: z.record(NonEmptyString, NonEmptyString).optional(),
    install: InstallSchema.optional(),
    doctor: DoctorSchema.optional(),
  })
  .strict();

// --- Inferred types ------------------------------------------------------

export type Config = z.infer<typeof ConfigSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Pipeline = z.infer<typeof PipelineSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
