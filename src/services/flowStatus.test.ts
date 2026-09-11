import { describe, expect, it } from "vitest";
import { flowStatus } from "./flowStatus.js";

describe("flowStatus", () => {
  it("is ok only when the payload is encrypted and the target enforces MFA", () => {
    expect(flowStatus(true, true)).toBe("ok");
  });

  it("warns when encrypted but the target has no MFA", () => {
    expect(flowStatus(true, false)).toBe("warn");
  });

  it("violates whenever the payload is unencrypted, MFA notwithstanding", () => {
    expect(flowStatus(false, false)).toBe("violation");
    expect(flowStatus(false, true)).toBe("violation");
  });
});
