/** Ribbon tone in the Sankey: green, amber, red. */
export type FlowStatus = "ok" | "warn" | "violation";

/**
 * A flow's compliance tone. Kept free of any database import so it stays a
 * pure, directly testable unit — same split as riskScoring.ts.
 *
 * Unencrypted PHI in transit is a violation outright, regardless of who can
 * reach it. Encrypted-but-unauthenticated is the softer failure — the payload
 * is protected, but access to the receiving asset is not gated by MFA — so it
 * warns rather than violates. mfaEnabled is read off the *target* asset,
 * because that is the system the records land in.
 */
export function flowStatus(encrypted: boolean, mfaEnabled: boolean): FlowStatus {
  if (!encrypted) return "violation";
  return mfaEnabled ? "ok" : "warn";
}
