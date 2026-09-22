import { describe, expect, it } from "vitest";
import {
  deriveAssetExposure, deriveControlGap, deriveVendorControlGap,
  deriveVendorExposure, explain, type AssetExposureInput,
} from "./riskFactors.js";

/**
 * The derivation rules, tested without a database.
 *
 * These are the numbers that now move automatically, so the thresholds matter:
 * a rule that silently changes meaning would rewrite every score in the estate
 * without anybody editing an assessment.
 */

const QUIET: AssetExposureInput = {
  phiVolume: 0,
  encrypted: true,
  mfaEnabled: true,
  liveGrants: 0,
  elevatedGrants: 0,
  vendorCount: 0,
  unencryptedOutboundFlows: 0,
  openSevereThreats: 0,
};

describe("deriveAssetExposure", () => {
  it("floors at 1 for a well-protected asset holding nothing", () => {
    const out = deriveAssetExposure(QUIET);
    expect(out.value).toBe(1);
    expect(out.points).toBe(0);
    expect(out.reasons).toHaveLength(0);
  });

  it("scales with PHI volume across the documented thresholds", () => {
    const at = (phiVolume: number) => deriveAssetExposure({ ...QUIET, phiVolume }).points;
    expect(at(10_000)).toBe(0);
    expect(at(10_001)).toBe(1);
    expect(at(50_001)).toBe(2);
    expect(at(200_001)).toBe(3);
  });

  it("ceilings at 5 when everything is wrong at once", () => {
    const out = deriveAssetExposure({
      phiVolume: 500_000, encrypted: false, mfaEnabled: false,
      liveGrants: 40, elevatedGrants: 12, vendorCount: 6,
      unencryptedOutboundFlows: 3, openSevereThreats: 2,
    });
    expect(out.value).toBe(5);
  });

  it("counts an open severe threat as evidence the exposure is real", () => {
    const without = deriveAssetExposure(QUIET).points;
    const with_ = deriveAssetExposure({ ...QUIET, openSevereThreats: 1 }).points;
    expect(with_ - without).toBe(1);
  });

  it("treats encryption and MFA as separate protections", () => {
    expect(deriveAssetExposure({ ...QUIET, encrypted: false }).points).toBe(1);
    expect(deriveAssetExposure({ ...QUIET, mfaEnabled: false }).points).toBe(1);
    expect(
      deriveAssetExposure({ ...QUIET, encrypted: false, mfaEnabled: false }).points,
    ).toBe(2);
  });

  it("weights access breadth above a handful of grants", () => {
    expect(deriveAssetExposure({ ...QUIET, liveGrants: 3 }).points).toBe(0);
    expect(deriveAssetExposure({ ...QUIET, liveGrants: 4 }).points).toBe(1);
    expect(deriveAssetExposure({ ...QUIET, liveGrants: 11 }).points).toBe(2);
  });

  it("explains itself with the facts it used, not a narrative", () => {
    const out = deriveAssetExposure({ ...QUIET, phiVolume: 87_100, encrypted: false });
    const text = explain(out);
    expect(text).toContain("87,100 PHI records");
    expect(text).toContain("PHI stored unencrypted");
  });

  it("omits rules that contributed nothing rather than padding the explanation", () => {
    const out = deriveAssetExposure({ ...QUIET, encrypted: false });
    expect(out.reasons.map((r) => r.rule)).toEqual(["not-encrypted-at-rest"]);
  });
});

describe("deriveControlGap", () => {
  it("is maximal when nothing effective is in place", () => {
    expect(deriveControlGap({ effective: 0, partial: 0 }).value).toBe(5);
  });

  it("counts a partial control as half an effective one", () => {
    expect(deriveControlGap({ effective: 0, partial: 2 }).points).toBe(1);
    expect(deriveControlGap({ effective: 1, partial: 0 }).points).toBe(1);
  });

  it("reaches the minimum gap at four weighted controls", () => {
    expect(deriveControlGap({ effective: 4, partial: 0 }).value).toBe(1);
    expect(deriveControlGap({ effective: 3, partial: 1 }).value).toBe(2);
  });

  /**
   * A control nobody has assessed is not a control that works. The caller
   * counts only IMPLEMENTED+EFFECTIVE as effective, so an unassessed one
   * arrives here as neither -- and must not reduce the gap.
   */
  it("gives no credit for controls that were never assessed", () => {
    expect(deriveControlGap({ effective: 0, partial: 0 }).value).toBe(5);
  });
});

describe("deriveVendorExposure", () => {
  it("is 1 for a vendor that can reach nothing", () => {
    expect(
      deriveVendorExposure({ reachablePhi: 0, assetCount: 0, unencryptedAssets: 0 }).value,
    ).toBe(1);
  });

  it("scales with reachable PHI and breadth", () => {
    const out = deriveVendorExposure({
      reachablePhi: 250_000, assetCount: 4, unencryptedAssets: 2,
    });
    expect(out.points).toBe(6);
    expect(out.value).toBe(4);
  });
});

describe("deriveVendorControlGap", () => {
  /**
   * The BAA is the control. Under HIPAA a vendor touching PHI without one is a
   * breach in itself, so a missing agreement is the maximum gap regardless of
   * how the vendor behaves in practice.
   */
  it("maps BAA state onto the gap", () => {
    const gap = (baaStatus: "SIGNED" | "PENDING" | "EXPIRED" | "MISSING") =>
      deriveVendorControlGap({ baaStatus, assessmentOverdue: false }).value;

    expect(gap("MISSING")).toBe(5);
    expect(gap("EXPIRED")).toBe(4);
    expect(gap("PENDING")).toBe(3);
    expect(gap("SIGNED")).toBe(1);
  });

  it("adds a point for an overdue reassessment", () => {
    expect(
      deriveVendorControlGap({ baaStatus: "SIGNED", assessmentOverdue: true }).value,
    ).toBe(2);
  });

  it("does not exceed the scale when already at the maximum", () => {
    expect(
      deriveVendorControlGap({ baaStatus: "MISSING", assessmentOverdue: true }).value,
    ).toBe(5);
  });

  it("names the BAA state in its explanation", () => {
    expect(
      explain(deriveVendorControlGap({ baaStatus: "EXPIRED", assessmentOverdue: false })),
    ).toContain("BAA is EXPIRED");
  });
});

describe("every derived factor stays on the 1-5 scale", () => {
  it("never leaves the scale, however extreme the input", () => {
    const extremes: AssetExposureInput[] = [
      QUIET,
      { ...QUIET, phiVolume: Number.MAX_SAFE_INTEGER, liveGrants: 10_000, vendorCount: 500,
        encrypted: false, mfaEnabled: false, elevatedGrants: 999,
        unencryptedOutboundFlows: 99, openSevereThreats: 99 },
    ];

    for (const input of extremes) {
      const v = deriveAssetExposure(input).value;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }

    for (const effective of [0, 1, 5, 100]) {
      const v = deriveControlGap({ effective, partial: 0 }).value;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });
});
