const fs = require("node:fs");
const crypto = require("node:crypto");
fs.mkdirSync("/secrets", { recursive: true });
for (const name of ["DB_PASSWORD", "SESSION_SECRET", "PAYMENT_SECRET"]) {
  if (!fs.existsSync(`/secrets/${name}`))
    fs.writeFileSync(
      `/secrets/${name}`,
      crypto.randomBytes(32).toString("hex"),
      { mode: 0o600 },
    );
}
