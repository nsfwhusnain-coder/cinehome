import type { HlsRecoveryPlan } from "./hls-quality";

/**
 * Structural subset of hls.js used by live quality policy. Keeping this small
 * makes the mutation contract testable without constructing a browser/MSE
 * engine: Auto hints must clear manual mode, and no live path may write the
 * destructive `currentLevel` setter.
 */
export interface HlsQualityEngine {
  capLevelToPlayerSize: boolean;
  autoLevelCapping: number;
  loadLevel: number;
  nextLoadLevel: number;
  nextLevel: number;
}

export function seedNextAutoLevel(
  engine: HlsQualityEngine,
  level: number
): void {
  engine.loadLevel = -1;
  engine.nextLoadLevel = level;
}

export function applyHlsRecoveryPlan(
  engine: HlsQualityEngine,
  plan: HlsRecoveryPlan
): void {
  engine.capLevelToPlayerSize = false;
  engine.autoLevelCapping = -1;
  if (plan.kind === "fixed") {
    engine.nextLevel = plan.level;
    return;
  }
  if (plan.kind !== "restart") {
    seedNextAutoLevel(engine, plan.level);
  }
}
