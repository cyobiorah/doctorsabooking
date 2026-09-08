import { hash } from "bcryptjs";
import { db } from "./db";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "./demo-accounts";
async function seed() {
  const passwordHash = await hash(DEMO_PASSWORD, 12);
  for (const user of DEMO_ACCOUNTS)
    await db.user.upsert({
      where: { email: user.email },
      create: { ...user, passwordHash },
      update: {},
    });
}
seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
