import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const port = Number(process.env.PORT ?? 4000);
const app = createApp();

const server = app.listen(port, () => {
  console.log(`[medguard] API listening on http://localhost:${port}`);
  console.log(`[medguard] CORS origin: ${process.env.FRONTEND_ORIGIN ?? "http://localhost:8080"}`);
});

// Close the pool on shutdown so `tsx watch` restarts do not leak connections.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void prisma.$disconnect().then(() => process.exit(0));
    });
  });
}
