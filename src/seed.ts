import { db } from "./db";
import { seedDemoData } from "./seed-data";

seedDemoData()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
