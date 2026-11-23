import http from "k6/http";
import { check, fail } from "k6";

/**
 * Phase 4 performance smoke test: login -> risk summary -> list assets ->
 * recompute one asset, against a running instance of the app (point
 * BASE_URL at it; defaults to the local dev server). Not a load test —
 * just a p95 budget so an obvious regression (an N+1 query, a missing
 * index) shows up before it reaches production.
 *
 * Run: npm run db:seed (so the asset/user below exist), npm run dev, then
 *   LOGIN_PASSWORD=<DEMO_USER_PASSWORD from .env> npm run perf:smoke
 * Override target: BASE_URL=... LOGIN_EMAIL=... LOGIN_PASSWORD=... ASSET_ID=... k6 run ...
 *
 * If something else on this machine already owns :4000, `npm run dev` will
 * silently fail to bind and every request here will quietly hit that other
 * process instead — confirmed to happen on at least one dev machine with an
 * older checkout of this project running elsewhere. If results look wrong,
 * `lsof -i :4000` before trusting them.
 */

const BASE_URL = __ENV.BASE_URL || "http://localhost:4000";
const LOGIN_EMAIL = __ENV.LOGIN_EMAIL || "admin@meridian.org";
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || __ENV.DEMO_USER_PASSWORD;
const ASSET_ID = __ENV.ASSET_ID || "6"; // Billing Engine DB in the Meridian seed

export const options = {
  scenarios: {
    smoke: {
      // 20 VUs x 3 iterations x 3 requests = 180 requests total, comfortably
      // under the global rate limiter's 300/15min window (src/middleware/security.ts) —
      // a sustained constant-vus flood would trip that limiter almost
      // instantly and measure the limiter, not the app.
      executor: "per-vu-iterations",
      vus: 20,
      iterations: 3,
      maxDuration: "30s",
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

// Login once for the whole run, not once per iteration — the per-route
// login rate limiter (Phase 3) is tuned for real login traffic, and 20 VUs
// each logging in every iteration trips it in well under a second.
export function setup() {
  if (!LOGIN_PASSWORD) fail("LOGIN_PASSWORD or DEMO_USER_PASSWORD env var must be set");

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(loginRes, { "login succeeds": (r) => r.status === 200 });
  const token = loginRes.json("data.token");
  if (!token) fail(`login did not return a token (status ${loginRes.status}): ${loginRes.body}`);
  return { token };
}

export default function ({ token }) {
  const authHeaders = { headers: { Authorization: `Bearer ${token}` } };

  const summaryRes = http.get(`${BASE_URL}/api/risks/distribution`, authHeaders);
  check(summaryRes, { "risk summary ok": (r) => r.status === 200 });

  const listRes = http.get(`${BASE_URL}/api/assets`, authHeaders);
  check(listRes, { "asset list ok": (r) => r.status === 200 });

  const recomputeRes = http.post(`${BASE_URL}/api/risks/${ASSET_ID}/recompute`, null, authHeaders);
  check(recomputeRes, { "recompute ok": (r) => r.status === 200 });
}
