import cron from "node-cron";
import { prisma } from "../lib/prisma.js";
import { recordAuthEventSafe } from "../services/auditService.js";
import { runNotificationSweep } from "../services/notificationService.js";

/**
 * A fixed, arbitrary 64-bit key for this specific job. Any two processes
 * calling `pg_try_advisory_lock` with the same key contend for the same
 * lock, which is exactly what keeps two API replicas from both running the
 * sweep at once — only the one that acquires it runs; the other sees `false`
 * and skips this tick entirely.
 */
const ADVISORY_LOCK_KEY = 847_362_910_142;

/** Runs the notification sweep for every organization, once, iff this process won the lock. */
export async function runDailySweepOnce(): Promise<void> {
  const [{ locked }] = await prisma.$queryRaw<[{ locked: boolean }]>`
    SELECT pg_try_advisory_lock(${ADVISORY_LOCK_KEY}) AS locked
  `;
  if (!locked) return;

  try {
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      const { created } = await runNotificationSweep(org.id);
      await recordAuthEventSafe({
        action: "SYSTEM_SWEEP_COMPLETED",
        actorEmail: "system@drishti.internal",
        organizationId: org.id,
        metadata: { notificationsCreated: created },
      });
    }
  } finally {
    await prisma.$queryRaw`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

/** Starts the daily cron. Call once from server.ts; never from a test or a route. */
export function startDailySweep(): void {
  cron.schedule("0 3 * * *", () => {
    void runDailySweepOnce().catch((err) => console.error("[drishti] daily sweep failed:", err));
  });
}
