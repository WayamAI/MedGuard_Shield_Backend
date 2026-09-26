import { describe, expect, it } from "vitest";
import { assetsAffectedBy } from "./importService.js";
import { specFor } from "./importSpec.js";

/**
 * Which assets an import has to recalculate.
 *
 * A CSV is the only way PHI flows enter the system, and unencrypted outbound
 * flows, live access grants and open severe threats all feed
 * `deriveAssetExposure`. Before this existed the import path recalculated
 * nothing, so a freshly imported estate reported risk its own data already
 * contradicted — and it stayed wrong until something unrelated happened to
 * touch the asset.
 *
 * Pure: no database, same split the rest of the import unit tests use.
 */

const flows = specFor("data-flows")!;
const grants = specFor("access-grants")!;
const threats = specFor("threats")!;
const assets = specFor("assets")!;
const vendors = specFor("vendors")!;
const phiTypes = specFor("phi-types")!;
const risks = specFor("risks")!;

describe("assetsAffectedBy", () => {
  it("returns the SOURCE asset of each flow, not the target", () => {
    // Exposure counts this asset's *outbound* unencrypted flows. The target
    // receives records; its own outbound count is untouched.
    const rows = [
      { sourceAssetId: 1, targetAssetId: 99, phiTypeId: 5, encrypted: false },
      { sourceAssetId: 2, targetAssetId: 99, phiTypeId: 5, encrypted: true },
    ];
    expect(assetsAffectedBy(flows, rows).sort()).toEqual([1, 2]);
    expect(assetsAffectedBy(flows, rows)).not.toContain(99);
  });

  it("includes the source of an encrypted flow too", () => {
    /*
     * Deliberately over-inclusive. `recalculate` suppresses no-op changes, so
     * an encrypted flow's source simply does not move and writes no history.
     * Filtering here would mean reproducing the engine's rule about which
     * flows count in a second place, and getting that wrong would silently
     * leave a stale score rather than merely costing a query.
     */
    expect(assetsAffectedBy(flows, [{ sourceAssetId: 7, encrypted: true }])).toEqual([7]);
  });

  it("deduplicates repeated subjects", () => {
    const rows = [
      { sourceAssetId: 3, targetAssetId: 4 },
      { sourceAssetId: 3, targetAssetId: 5 },
      { sourceAssetId: 3, targetAssetId: 6 },
    ];
    expect(assetsAffectedBy(flows, rows)).toEqual([3]);
  });

  it("returns the asset an access grant lands on", () => {
    expect(assetsAffectedBy(grants, [{ identityId: 1, assetId: 42 }])).toEqual([42]);
  });

  it("returns the asset a threat is detected against", () => {
    expect(assetsAffectedBy(threats, [{ assetId: 8, severity: "CRITICAL" }])).toEqual([8]);
  });

  it.each([
    ["assets", assets],
    ["vendors", vendors],
    ["phi-types", phiTypes],
    ["risks", risks],
  ])("returns nothing for %s, which cannot move a derived factor", (_label, spec) => {
    // assets and vendors arrive with no edges and no assessment, phi-types are
    // a vocabulary, and the risks importer writes its own Risk and
    // RiskHistory rows with a score it computes itself.
    expect(assetsAffectedBy(spec, [{ assetId: 1, sourceAssetId: 2, name: "x" }])).toEqual([]);
  });

  it("ignores rows whose reference did not resolve to a number", () => {
    const rows = [
      { sourceAssetId: 1 },
      { sourceAssetId: undefined },
      { sourceAssetId: null },
      { sourceAssetId: "12" },
      {},
    ];
    expect(assetsAffectedBy(flows, rows)).toEqual([1]);
  });

  it("returns an empty list for an empty file", () => {
    expect(assetsAffectedBy(flows, [])).toEqual([]);
  });
});
