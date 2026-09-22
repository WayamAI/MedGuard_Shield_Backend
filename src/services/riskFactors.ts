/**
 * Derivation of the two *observable* risk factors.
 *
 * The four-factor formula is unchanged and still lives in riskScoring.ts. What
 * this module decides is where two of those four numbers come from.
 *
 * ## Why only two
 *
 *   exposure    How reachable the thing is, and how much is behind it. That is
 *               a property of the graph: PHI volume, who holds access and at
 *               what level, how many vendors can reach it, whether traffic is
 *               encrypted, whether anything is actively being attacked. All of
 *               it is recorded fact.
 *
 *   controlGap  How little is protecting it. Also fact: which controls are
 *               applied, and whether anyone has assessed them as working.
 *
 *   likelihood  How motivated and capable an attacker is.
 *   impact      What a breach would actually cost this organisation.
 *
 * The last two are judgement. No amount of graph data yields them, and a
 * system that invented them would be fabricating the input that matters most.
 * They stay with the assessor.
 *
 * ## Why this is safe to automate
 *
 * Every rule below is a bucketed count of something the database already
 * records, and the thresholds are constants you can read. Nothing is weighted
 * by a model, fitted to data, or tuned to produce a pleasing number. When a
 * score moves, `explain()` returns the exact reasons, and those reasons are
 * stored on the history row — so "why did this go from 65 to 72" has a factual
 * answer rather than a narrative one.
 *
 * An assessor who disagrees pins the factor (see `exposureOverridden` /
 * `controlGapOverridden` on the Risk model) and the derivation stops touching
 * it. Their judgement outranks this.
 *
 * Pure functions only -- no Prisma import -- so every rule is unit-testable
 * without a database, the same split riskScoring.ts has from riskEngine.ts.
 */

/** The 1-5 scale every factor uses. */
export type Factor = 1 | 2 | 3 | 4 | 5;

/** One reason a factor landed where it did, for the history row. */
export type FactorReason = { rule: string; points: number; detail: string };

export type DerivedFactor = {
  value: Factor;
  points: number;
  reasons: FactorReason[];
};

/** Maps an accumulated point total onto the 1-5 scale. */
function bucket(points: number): Factor {
  if (points <= 1) return 1;
  if (points <= 3) return 2;
  if (points <= 5) return 3;
  if (points <= 7) return 4;
  return 5;
}

// ---------------------------------------------------------------- assets

export type AssetExposureInput = {
  phiVolume: number;
  encrypted: boolean;
  mfaEnabled: boolean;
  /** Grants not revoked. */
  liveGrants: number;
  /** Live grants at WRITE or ADMIN. */
  elevatedGrants: number;
  /** Vendors that can reach this asset. */
  vendorCount: number;
  /** Outbound flows carrying PHI unencrypted. */
  unencryptedOutboundFlows: number;
  /** Threats still OPEN or INVESTIGATING at HIGH or CRITICAL severity. */
  openSevereThreats: number;
};

/**
 * Exposure for one asset.
 *
 * PHI volume dominates because it is the thing that makes everything else
 * matter -- a wide-open system holding nothing is not an exposure. Everything
 * after it is an amplifier.
 */
export function deriveAssetExposure(input: AssetExposureInput): DerivedFactor {
  const reasons: FactorReason[] = [];
  const add = (rule: string, points: number, detail: string) => {
    if (points > 0) reasons.push({ rule, points, detail });
    return points;
  };

  let points = 0;

  points += add(
    "phi-volume",
    input.phiVolume > 200_000 ? 3 : input.phiVolume > 50_000 ? 2 : input.phiVolume > 10_000 ? 1 : 0,
    `${input.phiVolume.toLocaleString()} PHI records`,
  );

  points += add("not-encrypted-at-rest", input.encrypted ? 0 : 1, "PHI stored unencrypted");
  points += add("no-mfa", input.mfaEnabled ? 0 : 1, "access not protected by MFA");

  points += add(
    "access-breadth",
    input.liveGrants > 10 ? 2 : input.liveGrants > 3 ? 1 : 0,
    `${input.liveGrants} live access grant(s)`,
  );

  points += add(
    "elevated-access",
    input.elevatedGrants > 0 ? 1 : 0,
    `${input.elevatedGrants} grant(s) above READ`,
  );

  points += add(
    "vendor-reach",
    input.vendorCount >= 3 ? 2 : input.vendorCount > 0 ? 1 : 0,
    `${input.vendorCount} vendor(s) can reach it`,
  );

  points += add(
    "unencrypted-in-transit",
    input.unencryptedOutboundFlows > 0 ? 1 : 0,
    `${input.unencryptedOutboundFlows} unencrypted outbound flow(s)`,
  );

  // A live severe detection is evidence the exposure is not hypothetical.
  points += add(
    "active-threat",
    input.openSevereThreats > 0 ? 1 : 0,
    `${input.openSevereThreats} open HIGH/CRITICAL threat(s)`,
  );

  return { value: bucket(points), points, reasons };
}

export type ControlGapInput = {
  /** Applied controls that are IMPLEMENTED and assessed EFFECTIVE. */
  effective: number;
  /** Applied controls that are PARTIAL or only PARTIALLY_EFFECTIVE. */
  partial: number;
};

/**
 * Control gap for one asset.
 *
 * Inverted from coverage: five means nothing effective is in place. A control
 * that exists but has never been assessed counts for nothing -- NOT_ASSESSED
 * is not a synonym for working, and treating it as one is how a control
 * register becomes theatre.
 *
 * Same weighting the `/control-evidence` endpoint already showed operators,
 * so the number the API suggests and the number automation applies agree.
 */
export function deriveControlGap(input: ControlGapInput): DerivedFactor {
  const weighted = input.effective + input.partial * 0.5;

  const value: Factor =
    weighted >= 4 ? 1 : weighted >= 3 ? 2 : weighted >= 2 ? 3 : weighted >= 1 ? 4 : 5;

  return {
    value,
    points: weighted,
    reasons: [
      {
        rule: "control-coverage",
        points: weighted,
        detail:
          `${input.effective} effective + ${input.partial} partial control(s) ` +
          `= ${weighted} weighted coverage`,
      },
    ],
  };
}

// --------------------------------------------------------------- vendors

export type VendorExposureInput = {
  /** Total PHI across the assets this vendor can reach. */
  reachablePhi: number;
  assetCount: number;
  /** Reachable assets storing PHI unencrypted. */
  unencryptedAssets: number;
};

export function deriveVendorExposure(input: VendorExposureInput): DerivedFactor {
  const reasons: FactorReason[] = [];
  const add = (rule: string, points: number, detail: string) => {
    if (points > 0) reasons.push({ rule, points, detail });
    return points;
  };

  let points = 0;

  points += add(
    "reachable-phi",
    input.reachablePhi > 200_000 ? 3 : input.reachablePhi > 50_000 ? 2 : input.reachablePhi > 0 ? 1 : 0,
    `${input.reachablePhi.toLocaleString()} PHI records reachable`,
  );

  points += add(
    "asset-breadth",
    input.assetCount >= 3 ? 2 : input.assetCount > 0 ? 1 : 0,
    `${input.assetCount} asset(s) reachable`,
  );

  points += add(
    "unencrypted-assets",
    input.unencryptedAssets > 0 ? 1 : 0,
    `${input.unencryptedAssets} reachable asset(s) unencrypted`,
  );

  return { value: bucket(points), points, reasons };
}

export type VendorControlGapInput = {
  baaStatus: "SIGNED" | "PENDING" | "EXPIRED" | "MISSING";
  assessmentOverdue: boolean;
};

/**
 * Control gap for a vendor.
 *
 * The BAA is the control. Under HIPAA a vendor touching PHI without a signed
 * Business Associate Agreement is a compliance breach in itself, independent
 * of whether anything has leaked -- so a missing one is the maximum gap
 * regardless of how well the vendor behaves in practice.
 *
 * Vendors are not linked to Control records (controls attach to assets), so
 * unlike an asset there is no coverage count to fold in. If vendor-level
 * controls are ever modelled, they belong here.
 */
export function deriveVendorControlGap(input: VendorControlGapInput): DerivedFactor {
  const base =
    input.baaStatus === "MISSING" ? 5
    : input.baaStatus === "EXPIRED" ? 4
    : input.baaStatus === "PENDING" ? 3
    : 1;

  const reasons: FactorReason[] = [
    { rule: "baa-status", points: base, detail: `BAA is ${input.baaStatus}` },
  ];

  let value = base;
  if (input.assessmentOverdue && value < 5) {
    value += 1;
    reasons.push({
      rule: "assessment-overdue",
      points: 1,
      detail: "not reassessed within 365 days",
    });
  }

  return { value: value as Factor, points: value, reasons };
}

/** Flattens reasons into the one-line summary a history row carries. */
export function explain(factor: DerivedFactor): string {
  if (factor.reasons.length === 0) return "no contributing factors";
  return factor.reasons.map((r) => r.detail).join("; ");
}
