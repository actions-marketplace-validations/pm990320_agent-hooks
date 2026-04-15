import {
  bunDetector,
  npmDetector,
  pnpmDetector,
  yarnDetector,
} from "./node.ts";
import {
  pythonPipenvDetector,
  pythonPoetryDetector,
  pythonUvDetector,
} from "./python.ts";
import { denoDetector, goDetector, rustDetector } from "./rust-go-deno.ts";
import type { Detector } from "./types.ts";

/**
 * Canonical list of stack detectors. Order matters for how duplicate
 * step names get resolved during merge — earlier wins and later
 * detectors get their colliding step names prefixed.
 */
export const DETECTORS: readonly Detector[] = [
  bunDetector,
  pnpmDetector,
  yarnDetector,
  npmDetector,
  pythonUvDetector,
  pythonPoetryDetector,
  pythonPipenvDetector,
  rustDetector,
  goDetector,
  denoDetector,
];

export function getDetector(name: string): Detector | null {
  return DETECTORS.find((d) => d.name === name) ?? null;
}

export function listDetectorNames(): readonly string[] {
  return DETECTORS.map((d) => d.name);
}
