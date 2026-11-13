/**
 * Graded scorecard primitives (fork-only tooling, not part of upstream PRs).
 *
 * A scorecard is a list of weighted cases. Each case returns partial credit in
 * [0, 1] (booleans map to 0/1). A case that throws or times out scores 0.
 * The scorecard score is the weighted mean, scaled to 0–100.
 *
 * Scorecards are written BEFORE the feature they score, then locked
 * (sha256 in scoring/locks.json) so implementers cannot weaken them.
 * Import the code under test lazily inside `run()` so that missing modules
 * only zero the affected cases instead of crashing the whole scorecard.
 */

export type CaseResult = number | boolean;

export interface ScoreCase {
  /** Stable kebab-case id, unique within the scorecard. */
  id: string;
  /** What is being measured and why it matters. */
  description: string;
  /** Relative weight (> 0). */
  weight: number;
  /** Per-case timeout in ms (default 120 000). */
  timeoutMs?: number;
  run: () => CaseResult | Promise<CaseResult>;
}

export interface Scorecard {
  /** Feature id, matches the file name `scoring/features/<feature>.score.ts`. */
  feature: string;
  title: string;
  cases: ScoreCase[];
}

export function defineScorecard(scorecard: Scorecard): Scorecard {
  const ids = new Set<string>();
  for (const c of scorecard.cases) {
    if (ids.has(c.id)) throw new Error(`Duplicate case id "${c.id}" in ${scorecard.feature}`);
    if (!(c.weight > 0)) throw new Error(`Case "${c.id}" must have a positive weight`);
    ids.add(c.id);
  }
  return scorecard;
}

/** Clamp a raw result to [0, 1]. */
export function toCredit(result: CaseResult): number {
  if (typeof result === 'boolean') return result ? 1 : 0;
  if (!Number.isFinite(result)) return 0;
  return Math.min(1, Math.max(0, result));
}

/** Fraction of `hits` over `total` (0 when total is 0). */
export function ratio(hits: number, total: number): number {
  return total > 0 ? hits / total : 0;
}

/** F1 score from true positives, false positives and false negatives. */
export function f1(tp: number, fp: number, fn: number): number {
  const denom = 2 * tp + fp + fn;
  return denom === 0 ? 1 : (2 * tp) / denom;
}

/**
 * Linear credit for "smaller is better" metrics: full credit at or below
 * `best`, zero at or above `worst`.
 */
export function lowerIsBetter(value: number, best: number, worst: number): number {
  if (value <= best) return 1;
  if (value >= worst) return 0;
  return (worst - value) / (worst - best);
}

/** Linear credit for "bigger is better" metrics. */
export function higherIsBetter(value: number, worst: number, best: number): number {
  if (value >= best) return 1;
  if (value <= worst) return 0;
  return (value - worst) / (best - worst);
}

/** Mean credit over several sub-checks (each boolean or [0,1]). */
export function mean(results: CaseResult[]): number {
  if (results.length === 0) return 0;
  return results.reduce<number>((sum, r) => sum + toCredit(r), 0) / results.length;
}
