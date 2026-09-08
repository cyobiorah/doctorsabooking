import { createApp } from "./app";
import { createMockApp } from "./mock";
import { db } from "./db";
const mock = process.env.SERVICE === "mock";
const server = (mock ? createMockApp() : createApp()).listen(
  mock ? 3001 : 3000,
  () => console.log(`${mock ? "Mock payment" : "Booking"} service ready`),
);
const cleanup = setInterval(() => {
  if (!mock)
    void db.session
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(console.error);
}, 3600000);
cleanup.unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(cleanup);
    server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    });
  });
