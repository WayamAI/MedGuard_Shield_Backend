import type { RiskBand } from "../generated/prisma/client.js";
import { BadRequestError } from "../lib/errors.js";

/**
 * The scoring maths, deliberately free of any database import so it stays a
 * pure, directly testable unit. riskEngine.ts re-exports all of it, so callers
 * only ever need to know about riskEngine.
 */

/** Highest raw product the four 1-5 inputs can reach: 5 * 5 * 5 * 5. */
export const MAX_RAW_SCORE = 625;

export type RiskInputs = {
  likelihood: number;
  impact: number;
  exposure: number;
  controlGap: number;
};

export type RiskResult = {
  score: number;
  band: RiskBand;
};

/**
 * Band thresholds, as upper bounds on the normalised 0-100 score.
 *
 * Note the curve is steep: because the score is a product of four factors, a
 * genuinely bad-looking 4/4/4/3 assessment still normalises to only 30.72
 * (MODERATE), and EXTREME needs a raw product of 506+, i.e. effectively all 5s.
 * That is the spec'd formula; adjust here if the demo wants a gentler slope.
 */
const BAND_UPPER_BOUNDS: ReadonlyArray<readonly [number, RiskBand]> = [
  [20, "LOW"],
  [40, "MODERATE"],
  [60, "HIGH"],
  [80, "CRITICAL"],
];

function assertInRange(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new BadRequestError(`${label} must be an integer between 1 and 5, received ${value}`);
  }
}

/** Maps a normalised 0-100 score onto its band. */
export function bandForScore(score: number): RiskBand {
  for (const [upperBound, band] of BAND_UPPER_BOUNDS) {
    if (score <= upperBound) return band;
  }
  return "EXTREME";
}

/**
 * Pure scoring function. score = (l * i * e * c) / 625 * 100, rounded to two
 * decimals so the stored float stays readable in the UI.
 */
export function computeRisk(
  likelihood: number,
  impact: number,
  exposure: number,
  controlGap: number,
): RiskResult {
  assertInRange("likelihood", likelihood);
  assertInRange("impact", impact);
  assertInRange("exposure", exposure);
  assertInRange("controlGap", controlGap);

  const raw = likelihood * impact * exposure * controlGap;
  const score = Math.round((raw / MAX_RAW_SCORE) * 100 * 100) / 100;

  return { score, band: bandForScore(score) };
}
