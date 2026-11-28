import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bandForScore, computeRisk, MAX_RAW_SCORE } from "./riskScoring.js";

const factor = fc.integer({ min: 1, max: 5 });
const factors = fc.tuple(factor, factor, factor, factor);

describe("computeRisk", () => {
  it("scores a known input against the documented formula", () => {
    // 4 * 5 * 3 * 4 = 240 raw -> 240/625*100 = 38.4
    expect(computeRisk(4, 5, 3, 4)).toEqual({ score: 38.4, band: "MODERATE" });
  });

  it("floors at all 1s", () => {
    // 1/625*100 = 0.16
    expect(computeRisk(1, 1, 1, 1)).toEqual({ score: 0.16, band: "LOW" });
  });

  it("caps at all 5s", () => {
    expect(computeRisk(5, 5, 5, 5)).toEqual({ score: 100, band: "EXTREME" });
    expect(5 * 5 * 5 * 5).toBe(MAX_RAW_SCORE);
  });

  it("handles a mixed case", () => {
    // 2 * 4 * 5 * 3 = 120 raw -> 19.2
    expect(computeRisk(2, 4, 5, 3)).toEqual({ score: 19.2, band: "LOW" });
  });

  it("is order-independent across its factors", () => {
    expect(computeRisk(2, 3, 4, 5)).toEqual(computeRisk(5, 4, 3, 2));
  });

  it("rounds to two decimals", () => {
    // 3 * 3 * 3 * 3 = 81 raw -> 12.96
    expect(computeRisk(3, 3, 3, 3).score).toBe(12.96);
  });

  it("rejects out-of-range and non-integer inputs", () => {
    expect(() => computeRisk(0, 3, 3, 3)).toThrow(/likelihood/);
    expect(() => computeRisk(3, 6, 3, 3)).toThrow(/impact/);
    expect(() => computeRisk(3, 3, 2.5, 3)).toThrow(/exposure/);
    expect(() => computeRisk(3, 3, 3, -1)).toThrow(/controlGap/);
  });
});

describe("bandForScore", () => {
  it("places each band boundary on the lower band", () => {
    expect(bandForScore(0)).toBe("LOW");
    expect(bandForScore(20)).toBe("LOW");
    expect(bandForScore(20.01)).toBe("MODERATE");
    expect(bandForScore(40)).toBe("MODERATE");
    expect(bandForScore(40.01)).toBe("HIGH");
    expect(bandForScore(60)).toBe("HIGH");
    expect(bandForScore(60.01)).toBe("CRITICAL");
    expect(bandForScore(80)).toBe("CRITICAL");
    expect(bandForScore(80.01)).toBe("EXTREME");
    expect(bandForScore(100)).toBe("EXTREME");
  });

  it("agrees with the bands computeRisk reports", () => {
    const cases: Array<[number, number, number, number, string]> = [
      [3, 3, 3, 3, "LOW"],       // 12.96
      [4, 4, 4, 3, "MODERATE"],  // 30.72
      [5, 5, 5, 3, "HIGH"],      // 60
      [5, 5, 5, 4, "CRITICAL"],  // 80
      [5, 5, 5, 5, "EXTREME"],   // 100
    ];
    for (const [l, i, e, c, band] of cases) {
      expect(computeRisk(l, i, e, c).band, `${l}/${i}/${e}/${c}`).toBe(band);
    }
  });
});

describe("computeRisk — properties", () => {
  it("score is always in [0, 100] for every valid factor combination", () => {
    fc.assert(
      fc.property(factors, ([l, i, e, c]) => {
        const { score } = computeRisk(l, i, e, c);
        return score >= 0 && score <= 100;
      }),
    );
  });

  it("is deterministic — the same inputs always produce the same output", () => {
    fc.assert(
      fc.property(factors, ([l, i, e, c]) => {
        const a = computeRisk(l, i, e, c);
        const b = computeRisk(l, i, e, c);
        return a.score === b.score && a.band === b.band;
      }),
    );
  });

  it("is monotonic — raising any one factor never lowers the score", () => {
    fc.assert(
      fc.property(factors, fc.integer({ min: 0, max: 3 }), (base, factorIndex) => {
        const [l, i, e, c] = base;
        const current = base[factorIndex];
        fc.pre(current < 5);

        const raised = [...base] as [number, number, number, number];
        raised[factorIndex] = current + 1;

        const before = computeRisk(l, i, e, c).score;
        const after = computeRisk(...raised).score;
        return after >= before;
      }),
    );
  });
});
