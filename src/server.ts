import "dotenv/config";
import { env } from "./config.js";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { startDailySweep } from "./jobs/dailySweep.js";

const port = env.PORT;
const app = createApp();

const server = app.listen(port, () => {
  console.log(`[drishti] API listening on http://localhost:${port}`);
  console.log(`[drishti] CORS origin: ${env.FRONTEND_ORIGIN}`);
});

/**
 * Without this, a taken port fails silently from the operator's point of
 * view: `listen()`'s `error` event has nothing else to catch it, Node's
 * default behaviour for an unhandled `error` event is to throw, and under
 * `tsx watch` that throw just triggers an endless crash-restart loop —
 * `ps` still shows a live process the whole time, the port is never
 * actually bound, and every request silently reaches whatever else *is*
 * listening on that port instead (confirmed live: a second checkout of
 * this project on a different port on the same machine).
 */
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[drishti] Port ${port} is already in use — refusing to start. ` +
        `Find what's using it with \`lsof -i :${port}\`, or set PORT to something else.`,
    );
  } else {
    console.error("[drishti] failed to start:", err);
  }
  process.exit(1);
});

startDailySweep();

// Close the pool on shutdown so `tsx watch` restarts do not leak connections.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
}
