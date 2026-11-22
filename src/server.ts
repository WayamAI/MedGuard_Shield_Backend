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

startDailySweep();

// Close the pool on shutdown so `tsx watch` restarts do not leak connections.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
}
