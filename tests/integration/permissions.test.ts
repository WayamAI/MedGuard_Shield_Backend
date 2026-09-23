import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { prisma } from "../../src/lib/prisma.js";
import { seedFixture, tokenFor, type Fixture } from "../helpers.js";
import { ANALYST_CONTROL_FIELDS, can, rolesWith } from "../../src/lib/permissions.js";

/**
 * The permission matrix, exercised through HTTP rather than asserted against
 * the table that defines it.
 *
 * Every mutation is attempted as ADMIN, ANALYST, VIEWER, anonymously, and from
 * another organisation. The table-driven block at the bottom is the one that
 * matters: it is mechanical, so a route added without a gate shows up as a
 * missing row rather than as a quiet hole.
 *
 * The distinction being enforced: ADMIN configures the estate, ANALYST works
 * within it. An analyst who can invent assets, grant access or rewrite the
 * policy register is an admin with a different label.
 */

const app = createApp();

let ids: Fixture;
let admin: string;
let analyst: string;
let viewer: string;
let outsider: string;

/**
 * Records these cases mutate. Created here rather than in the shared fixture,
 * because several other suites assert exact collection counts and adding rows
 * to the fixture would quietly break them.
 */
type Scratch = {
  vendorId: number; identityId: number; controlId: number;
  grantId: number; threatId: number; remediationId: number;
};
let scratch: Scratch;

/** The fixture plus the scratch ids, which is what the case table reads. */
type Subject = Fixture & {
  permVendorId: number; permIdentityId: number; permControlId: number;
  permGrantId: number; permThreatId: number; permRemediationId: number;
};
let subject: Subject;

beforeEach(async () => {
  ids = await seedFixture();
  admin = await tokenFor(request(app), "admin@test.local");
  analyst = await tokenFor(request(app), "analyst@test.local");
  viewer = await tokenFor(request(app), "viewer@test.local");
  outsider = await tokenFor(request(app), "outsider@rival.local");

  const organizationId = ids.organizationId;
  const [vendor, identity, control] = await Promise.all([
    prisma.vendor.create({ data: { organizationId, name: "Scratch Vendor" } }),
    prisma.identity.create({ data: { organizationId, displayName: "Scratch Person", kind: "USER" } }),
    prisma.control.create({
      data: {
        organizationId, name: "Scratch Control", description: "d",
        category: "ACCESS", owner: "Original Owner",
      },
    }),
  ]);
  const [grant, threat, remediation] = await Promise.all([
    prisma.accessGrant.create({
      data: { organizationId, identityId: identity.id, assetId: ids.ehrId },
    }),
    prisma.threat.create({
      data: {
        organizationId, assetId: ids.ehrId, severity: "LOW",
        title: "Scratch threat", description: "d",
      },
    }),
    prisma.remediation.create({
      data: { organizationId, title: "Scratch finding", description: "d", recommendation: "r" },
    }),
  ]);

  scratch = {
    vendorId: vendor.id, identityId: identity.id, controlId: control.id,
    grantId: grant.id, threatId: threat.id, remediationId: remediation.id,
  };
  subject = {
    ...ids,
    permVendorId: scratch.vendorId,
    permIdentityId: scratch.identityId,
    permControlId: scratch.controlId,
    permGrantId: scratch.grantId,
    permThreatId: scratch.threatId,
    permRemediationId: scratch.remediationId,
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

type Method = "post" | "patch" | "put" | "delete";

function call(method: Method, path: string, token: string | null, body?: object) {
  const req = request(app)[method](path);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return body ? req.send(body) : req.send();
}

describe("the matrix itself", () => {
  it("gives ADMIN everything", () => {
    for (const p of ["asset:create", "vendor:archive", "audit:read", "import:execute"] as const) {
      expect(can("ADMIN", p)).toBe(true);
    }
  });

  it("gives VIEWER reads and nothing else", () => {
    expect(can("VIEWER", "asset:read")).toBe(true);
    expect(can("VIEWER", "asset:assess")).toBe(false);
    expect(can("VIEWER", "threat:transition")).toBe(false);
  });

  it("gives ANALYST analysis but not configuration", () => {
    // Analysis and investigation.
    for (const p of [
      "asset:assess", "vendor:assess", "threat:create", "threat:transition",
      "remediation:create", "remediation:transition", "access:review", "control:assess",
    ] as const) {
      expect(can("ANALYST", p), `ANALYST should hold ${p}`).toBe(true);
    }

    // Configuration — changing what the estate *is*.
    for (const p of [
      "asset:create", "asset:update", "asset:archive",
      "vendor:create", "vendor:update", "vendor:archive",
      "identity:create", "identity:update", "identity:archive",
      "access:grant", "access:update", "access:revoke",
      "control:create", "control:update", "control:archive",
      "policy:create", "policy:update", "policy:archive",
      "audit:read", "import:execute",
    ] as const) {
      expect(can("ANALYST", p), `ANALYST should NOT hold ${p}`).toBe(false);
    }
  });

  it("keeps the audit trail and import contract away from non-admins", () => {
    expect(rolesWith("audit:read")).toEqual(["ADMIN"]);
    expect(rolesWith("import:read")).toEqual(["ADMIN"]);
  });
});

/**
 * One row per mutating endpoint. `allowed` lists exactly the roles that may
 * perform it; every other authenticated role must get 403, anonymous must get
 * 401, and a caller from another organisation must not succeed.
 */
type Case = {
  name: string;
  method: Method;
  path: (f: Subject) => string;
  body?: object;
  allowed: Array<"ADMIN" | "ANALYST">;
  /**
   * True when the path addresses a record belonging to *our* organisation, so
   * a caller from another tenant must be refused. False for creates, which
   * every tenant may legitimately perform in their own organisation.
   */
  targetsOurRecord: boolean;
};

const CASES: Case[] = [
  // ---- inventory: ADMIN only -------------------------------------------
  { name: "create asset", method: "post", path: () => "/api/assets",
    body: { name: "Perm Asset", type: "API" }, targetsOurRecord: false, allowed: ["ADMIN"] },
  { name: "update asset", method: "patch", path: (f) => `/api/assets/${f.ehrId}`,
    body: { phiVolume: 42 }, targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "archive asset", method: "post", path: (f) => `/api/assets/${f.billingId}/archive`,
    targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "create vendor", method: "post", path: () => "/api/vendors",
    body: { name: "Perm Vendor" }, targetsOurRecord: false, allowed: ["ADMIN"] },
  { name: "update vendor", method: "patch", path: (f) => `/api/vendors/${f.permVendorId}`,
    body: { baaStatus: "SIGNED" }, targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "create identity", method: "post", path: () => "/api/identities",
    body: { displayName: "Perm Person" }, targetsOurRecord: false, allowed: ["ADMIN"] },
  { name: "update identity", method: "patch", path: (f) => `/api/identities/${f.permIdentityId}`,
    body: { department: "IT" }, targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "create control", method: "post", path: () => "/api/controls",
    body: { name: "Perm Control", description: "d", category: "ACCESS" }, targetsOurRecord: false, allowed: ["ADMIN"] },
  { name: "archive control", method: "post", path: (f) => `/api/controls/${f.permControlId}/archive`,
    targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "link control to asset", method: "put",
    path: (f) => `/api/controls/${f.permControlId}/assets/${f.ehrId}`, targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "create policy", method: "post", path: () => "/api/policies",
    body: { name: "Perm Policy", description: "d" }, targetsOurRecord: false, allowed: ["ADMIN"] },

  // ---- who can reach PHI: ADMIN only ------------------------------------
  // Path carries no id, but the body names our identity and asset -- so this
  // IS an attempt on our records and an outsider must be refused.
  { name: "grant access", method: "post", path: () => "/api/access",
    body: undefined, targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "revoke access", method: "post", path: (f) => `/api/access/${f.permGrantId}/revoke`,
    targetsOurRecord: true, allowed: ["ADMIN"] },
  { name: "update access level", method: "patch", path: (f) => `/api/access/${f.permGrantId}`,
    body: { level: "WRITE" }, targetsOurRecord: true, allowed: ["ADMIN"] },

  // ---- analysis and investigation: ADMIN + ANALYST ----------------------
  { name: "assess asset risk", method: "post", path: (f) => `/api/assets/${f.ehrId}/assessment`,
    body: { likelihood: 3, impact: 3, exposure: 3, controlGap: 3 }, targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  { name: "recompute asset risk", method: "post", path: (f) => `/api/assets/${f.ehrId}/recompute`,
    targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  { name: "assess vendor risk", method: "post", path: (f) => `/api/vendors/${f.permVendorId}/assessment`,
    body: { likelihood: 3, impact: 3, exposure: 3, controlGap: 3 }, targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  // Same: the body names our asset.
  { name: "create threat", method: "post", path: () => "/api/threats",
    body: undefined, targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  { name: "transition threat", method: "post", path: (f) => `/api/threats/${f.permThreatId}/status`,
    body: { status: "INVESTIGATING" }, targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  { name: "create remediation", method: "post", path: () => "/api/remediations",
    body: { title: "Perm finding", description: "d", recommendation: "r" },
    targetsOurRecord: false, allowed: ["ADMIN", "ANALYST"] },
  { name: "transition remediation", method: "post",
    path: (f) => `/api/remediations/${f.permRemediationId}/status`,
    body: { status: "IN_PROGRESS" }, targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
  { name: "review access grant", method: "post", path: (f) => `/api/access/${f.permGrantId}/review`,
    targetsOurRecord: true, allowed: ["ADMIN", "ANALYST"] },
];

/**
 * Bodies that need ids from the fixture are built here rather than in the
 * table, because the table is declared before the fixture exists.
 */
function bodyFor(c: Case, f: Subject): object | undefined {
  if (c.name === "grant access") {
    return { identityId: f.permIdentityId, assetId: f.billingId };
  }
  if (c.name === "create threat") {
    return { assetId: f.ehrId, severity: "LOW", title: `Perm threat ${Math.round(performance.now() * 1000)}`, description: "d" };
  }
  return c.body;
}

describe("every mutation, every caller", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      for (const role of ["ADMIN", "ANALYST"] as const) {
        const shouldAllow = c.allowed.includes(role);

        it(`${shouldAllow ? "allows" : "refuses"} ${role}`, async () => {
          const token = role === "ADMIN" ? admin : analyst;
          const res = await call(c.method, c.path(subject), token, bodyFor(c, subject));

          if (shouldAllow) {
            expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
          } else {
            expect(res.status, JSON.stringify(res.body)).toBe(403);
            expect(res.body.error.code).toBe("FORBIDDEN");
          }
        });
      }

      it("refuses VIEWER", async () => {
        const res = await call(c.method, c.path(subject), viewer, bodyFor(c, subject));
        expect(res.status).toBe(403);
      });

      it("refuses an anonymous caller with 401, not 403", async () => {
        const res = await call(c.method, c.path(subject), null, bodyFor(c, subject));
        expect(res.status).toBe(401);
      });

      /**
       * An ADMIN of another organisation must never reach *our* records.
       *
       * The assertion splits by case shape, because the two are genuinely
       * different operations. A create with no id in the path is not an
       * attempt on our data at all -- the outsider is entitled to create the
       * same thing in their own tenant, and the correct outcome is a 201 whose
       * row lands in *their* organisation. Asserting 4xx there would be
       * asserting that tenants cannot use the API.
       *
       * Anything addressing an existing record by id is an attempt on our
       * data, and must fail.
       */
      it("refuses an ADMIN from another organization", async () => {
        const path = c.path(subject);
        const res = await call(c.method, path, outsider, bodyFor(c, subject));

        if (c.targetsOurRecord) {
          expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
          return;
        }

        // A create: allowed, but it must land in the outsider's organisation.
        expect(res.status, JSON.stringify(res.body)).toBe(201);

        /*
         * Prove ownership by visibility rather than by reading an
         * organizationId off the response body.
         *
         * Not every resource echoes that column back — and the ones that do
         * are arguably leaking internal plumbing — so asserting on it made
         * this test depend on a detail it does not care about. Who can see
         * the record is the property that actually matters, and checking it
         * this way is both shape-independent and stricter.
         */
        const newId = res.body.data.id as number;
        const collection = c.path(subject);

        const theirs = await request(app).get(`${collection}?pageSize=200`)
          .set("Authorization", `Bearer ${outsider}`);
        const ours = await request(app).get(`${collection}?pageSize=200`)
          .set("Authorization", `Bearer ${admin}`);

        const idsIn = (body: { data?: Array<{ id: number }> }) =>
          (body.data ?? []).map((row) => row.id);

        expect(idsIn(theirs.body)).toContain(newId);
        expect(idsIn(ours.body)).not.toContain(newId);
      });
    });
  }
});

describe("control assessment is field-scoped for ANALYST", () => {
  it("lets an ANALYST record effectiveness", async () => {
    const res = await call("patch", `/api/controls/${subject.permControlId}`, analyst, {
      effectiveness: "INEFFECTIVE",
      status: "PARTIAL",
      lastReviewedAt: "2026-09-01",
    });

    expect(res.status).toBe(200);
    expect(res.body.data.effectiveness).toBe("INEFFECTIVE");
  });

  it("refuses an ANALYST renaming or recategorising it, and names the fields", async () => {
    const res = await call("patch", `/api/controls/${subject.permControlId}`, analyst, {
      name: "Renamed By Analyst",
      effectiveness: "EFFECTIVE",
    });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("name");

    const control = await prisma.control.findUniqueOrThrow({ where: { id: subject.permControlId } });
    expect(control.name).not.toBe("Renamed By Analyst");
  });

  it("refuses an ANALYST changing the owner or framework reference", async () => {
    for (const field of ["owner", "frameworkRef"]) {
      const res = await call("patch", `/api/controls/${subject.permControlId}`, analyst, {
        [field]: "changed",
      });
      expect(res.status, field).toBe(403);
    }
  });

  it("lets an ADMIN change anything", async () => {
    const res = await call("patch", `/api/controls/${subject.permControlId}`, admin, {
      name: "Renamed By Admin",
      owner: "Someone",
      effectiveness: "EFFECTIVE",
    });
    expect(res.status).toBe(200);
  });

  it("agrees with the exported field list", () => {
    expect([...ANALYST_CONTROL_FIELDS].sort()).toEqual(
      ["effectiveness", "lastReviewedAt", "status"],
    );
  });
});

describe("admin-only surfaces", () => {
  it("keeps the audit trail ADMIN-only", async () => {
    for (const [token, expected] of [[admin, 200], [analyst, 403], [viewer, 403]] as const) {
      const res = await request(app).get("/api/audit").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(expected);
    }
  });

  it("keeps every import endpoint ADMIN-only", async () => {
    const paths = ["/api/import", "/api/import/assets/template"];
    for (const path of paths) {
      for (const [token, expected] of [[admin, 200], [analyst, 403], [viewer, 403]] as const) {
        const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
        expect(res.status, `${path} as token`).toBe(expected);
      }
    }
  });

  it("refuses an ANALYST running an import", async () => {
    const res = await request(app)
      .post("/api/import/assets")
      .set("Authorization", `Bearer ${analyst}`)
      .attach("file", Buffer.from("name,type\nX,API\n"), "assets.csv");

    expect(res.status).toBe(403);
    expect(await prisma.asset.findFirst({ where: { name: "X" } })).toBeNull();
  });
});

describe("reads stay open to every authenticated role", () => {
  it("lets a VIEWER read every non-admin collection", async () => {
    const paths = [
      "/api/organization", "/api/assets", "/api/vendors", "/api/identities",
      "/api/access", "/api/threats", "/api/controls", "/api/policies",
      "/api/remediations", "/api/risks", "/api/dataflows",
      "/api/reports/risk-assessment", "/api/search?q=Test",
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${viewer}`);
      expect(res.status, path).toBe(200);
    }
  });
});
