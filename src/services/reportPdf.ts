import PDFDocument from "pdfkit";
import type { TenantContext } from "../lib/tenant.js";
import type { riskAssessmentDetail } from "./reportService.js";

type Detail = Awaited<ReturnType<typeof riskAssessmentDetail>>;

/**
 * Renders the risk assessment report as a PDF, using the same figures the
 * JSON/CSV endpoints serve — nothing here is computed independently, so the
 * three formats can never disagree.
 */
export function renderRiskAssessmentPdf(detail: Detail, ctx: TenantContext): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 50 });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const h1 = () => doc.fontSize(18).font("Helvetica-Bold");
  const h2 = () => doc.fontSize(13).font("Helvetica-Bold");
  const body = () => doc.fontSize(10).font("Helvetica");
  const gap = (n = 1) => doc.moveDown(n);

  h1().text(`${detail.organization?.name ?? "Organization"} — Risk Assessment Report`);
  body().text(`Generated ${detail.generatedAt.toISOString()} by ${ctx.email}`);
  gap();
  body()
    .fillColor("#555")
    .text(detail.disclaimer, { width: 500 })
    .fillColor("#000");
  gap();

  h2().text("Risk band distribution");
  body().text(
    Object.entries(detail.riskDistribution as Record<string, number>)
      .map(([band, count]) => `${band}: ${count}`)
      .join("   "),
  );
  gap();

  h2().text("Top risks");
  for (const r of detail.topRisks) {
    body().text(`${r.assetName} (${r.assetType}) — score ${r.score} (${r.band})`);
  }
  gap();

  h2().text("Vendors without a valid BAA");
  if (detail.vendorsWithoutBaa.length === 0) body().text("None.");
  for (const v of detail.vendorsWithoutBaa) {
    body().text(`${v.name} — BAA ${v.baaStatus}, ${v.phiVolume.toLocaleString()} PHI records`);
  }
  gap();

  h2().text("Flagged access grants");
  if (detail.flaggedAccess.length === 0) body().text("None.");
  for (const g of detail.flaggedAccess as Array<{ identityName: string; assetName: string; flags: string[] }>) {
    body().text(`${g.identityName} → ${g.assetName}: ${g.flags.join(", ")}`);
  }
  gap();

  h2().text("Open threats");
  if (detail.openThreats.length === 0) body().text("None.");
  for (const t of detail.openThreats as Array<{ title: string; severity: string; status: string }>) {
    body().text(`${t.title} — ${t.severity} (${t.status})`);
  }
  gap();

  h2().text("Remediation");
  body().text(
    `Open: ${detail.remediation.open}   Resolved: ${detail.remediation.byStatus.RESOLVED}   ` +
      `Risk accepted: ${detail.remediation.byStatus.ACCEPTED}   Overdue: ${detail.remediation.overdue}`,
  );
  gap();

  h2().text("Control status");
  for (const c of detail.controlRegister as Array<{
    name: string;
    status: string;
    effectiveness: string;
    frameworkRef: string | null;
  }>) {
    body().text(`${c.name} — ${c.status} / ${c.effectiveness}${c.frameworkRef ? ` (${c.frameworkRef})` : ""}`);
  }

  doc.end();
  return done;
}
