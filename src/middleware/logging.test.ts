import { describe, expect, it } from "vitest";
import pino from "pino";
import { REDACT_PATHS } from "./logging.js";

/**
 * Proves the redact config actually hides every field it claims to, by
 * building a real pino logger with it and capturing what gets written —
 * not just reading the list of paths and trusting it matches.
 */
function logOnce(payload: object): string {
  let captured = "";
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: "[Redacted]" } },
    { write: (chunk: string) => { captured += chunk; } },
  );
  logger.info(payload, "test entry");
  return captured;
}

describe("log redaction", () => {
  it("redacts an Authorization header and a cookie", () => {
    const out = logOnce({ req: { headers: { authorization: "Bearer secret-token-value", cookie: "drishti_refresh=abc123" } } });
    expect(out).not.toContain("secret-token-value");
    expect(out).not.toContain("abc123");
    expect(out).toContain("[Redacted]");
  });

  it("redacts an X-API-Key header", () => {
    const out = logOnce({ req: { headers: { "x-api-key": "drishti_super-secret-key" } } });
    expect(out).not.toContain("drishti_super-secret-key");
  });

  it("redacts password, token, secret, TOTP code and recovery-code fields at any object level", () => {
    const sensitive = {
      password: "plaintext-password",
      passwordHash: "bcrypt-hash-value",
      token: "a-refresh-token",
      apiKey: "a-plaintext-api-key",
      secret: "a-totp-secret",
      mfaSecret: "another-totp-secret",
      code: "123456",
      recoveryCodes: ["aaaa1111", "bbbb2222"],
      tokenHash: "sha256-of-a-token",
      keyHash: "sha256-of-a-key",
    };
    const out = logOnce({ nested: { ...sensitive } });
    for (const value of [
      "plaintext-password", "bcrypt-hash-value", "a-refresh-token", "a-plaintext-api-key",
      "a-totp-secret", "another-totp-secret", "123456", "aaaa1111", "bbbb2222",
      "sha256-of-a-token", "sha256-of-a-key",
    ]) {
      expect(out).not.toContain(value);
    }
  });

  it("redacts patient-identifier-shaped field names", () => {
    const out = logOnce({ metadata: { ssn: "123-45-6789", mrn: "MRN4471829", dob: "1985-04-12", dateOfBirth: "1985-04-12" } });
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("MRN4471829");
    expect(out).not.toContain("1985-04-12");
  });

  it("does not redact ordinary, non-sensitive fields", () => {
    const out = logOnce({ req: { method: "POST", url: "/api/assets" } });
    expect(out).toContain("POST");
    expect(out).toContain("/api/assets");
  });
});
