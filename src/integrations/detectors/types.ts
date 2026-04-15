/**
 * Stack detector contract. Each detector inspects a project root and
 * emits a partial agent-hooks config fragment when its signal files
 * are present. `init` composes fragments from every detector that
 * fires.
 *
 * Fragments are intentionally *partial* — steps and pipelines only.
 * The merger in `src/integrations/detectors/merge.ts` is responsible
 * for deduping step names, combining pipelines, and writing the
 * final YAML document.
 */
export interface DetectorFs {
  exists(p: string): Promise<boolean>;
  read(p: string): Promise<string>;
}

/**
 * A step fragment contributed by a detector. Only the fields a
 * detector actually needs to populate are modeled here; everything
 * else is filled in by the merger with agent-hooks schema defaults.
 */
export interface DetectedStep {
  readonly run: string;
  readonly files?: string;
  readonly invocation?: "args" | "project" | "per-file";
  readonly tags?: readonly string[];
  readonly description?: string;
}

/**
 * A pipeline fragment. Detectors typically contribute to the well-known
 * `ci` and `pre-commit` pipelines; the merger unions entries across
 * detectors and dedupes step references in order.
 */
export interface DetectedPipeline {
  readonly steps: readonly string[];
  readonly parallel?: boolean;
  readonly "exclude-tags"?: readonly string[];
}

/**
 * Git hook entries contributed by a detector — e.g. a post-merge hook
 * that re-runs `bun install` when the lockfile changed.
 */
export interface DetectedGitHook {
  readonly pipeline: string;
}

/**
 * Complete fragment a detector returns. Every field is optional so
 * detectors can contribute selectively.
 */
export interface DetectorFragment {
  readonly steps?: Readonly<Record<string, DetectedStep>>;
  readonly pipelines?: Readonly<Record<string, DetectedPipeline>>;
  readonly gitHooks?: Readonly<Record<string, DetectedGitHook>>;
  /** Free-form notes shown in the init plan summary. */
  readonly notes?: readonly string[];
}

export interface DetectorContext {
  readonly cwd: string;
  readonly fs: DetectorFs;
}

export interface Detector {
  readonly name: string;
  readonly displayName: string;
  /** Return true if this detector should contribute to the init fragment. */
  detect(ctx: DetectorContext): Promise<boolean>;
  /** Produce the fragment this detector wants to contribute. */
  template(ctx: DetectorContext): Promise<DetectorFragment>;
}
