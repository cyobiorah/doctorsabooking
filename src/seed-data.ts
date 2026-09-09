import { hash } from "bcryptjs";
import { db } from "./db";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "./demo-accounts";
import { DEFAULT_LOCATIONS, DEMO_DOCTOR_LOCATIONS } from "./locations";
export async function seedDemoData() {
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
  for (const user of DEMO_ACCOUNTS) {
    const slugs = DEMO_DOCTOR_LOCATIONS[user.email] ?? [];
    await db.user.upsert({
      where: { email: user.email },
      create: {
        ...user,
        passwordHash,
        doctorLocations: {
          create: slugs.map((slug) => ({
            locationId: locations.get(slug)!.id,
          })),
        },
      },
      // Defaults belong to first-time provisioning, not subsequent restarts.
      update: {},
    });
  }
}
