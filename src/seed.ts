import { hash } from "bcryptjs";
import { db } from "./db";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "./demo-accounts";
import { DEFAULT_LOCATIONS, DEMO_DOCTOR_LOCATIONS } from "./locations";
async function seed() {
  const passwordHash = await hash(DEMO_PASSWORD, 12);
  const locations = new Map<string, { id: string }>();
  for (const location of DEFAULT_LOCATIONS) {
    const saved = await db.location.upsert({
      where: { slug: location.slug },
      create: location,
      update: { name: location.name, country: location.country, active: true },
      select: { id: true },
    });
    locations.set(location.slug, saved);
  }
  for (const user of DEMO_ACCOUNTS)
    await db.user.upsert({
      where: { email: user.email },
      create: { ...user, passwordHash },
      update: {},
    });
  for (const [email, slugs] of Object.entries(DEMO_DOCTOR_LOCATIONS)) {
    const doctor = await db.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    await db.doctorLocation.createMany({
      data: slugs.map((slug) => ({
        doctorId: doctor.id,
        locationId: locations.get(slug)!.id,
      })),
      skipDuplicates: true,
    });
  }
}
seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
