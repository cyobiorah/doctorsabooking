import request from "supertest";
import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import { db } from "../src/db";
import { createApp } from "../src/app";
import { createMockApp } from "../src/mock";
import { secret } from "../src/config";
import { DEMO_ACCOUNTS } from "../src/demo-accounts";
import {
  Actor,
  createVisit,
  submitBid,
  selectAndPay,
  confirmPayment,
  PaymentEvent,
  updateDoctorLocations,
} from "../src/services";

if (
  !new URL(
    process.env.DATABASE_URL ?? "mysql://localhost/invalid",
  ).pathname.endsWith("/doctorsa_test")
)
  throw new Error("Tests require the dedicated doctorsa_test database.");
process.env.SESSION_SECRET ??= "test-session-secret-not-for-deployment";
process.env.PAYMENT_SECRET ??= "test-payment-secret-not-for-deployment";
const app = createApp();
let patient: Actor, otherPatient: Actor, doctor: Actor, otherDoctor: Actor;
let locationIds: Record<string, string>;
const auth = () => `Bearer ${secret("PAYMENT_SECRET")}`;
const csrf = (html: string) => {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error("Missing CSRF form token");
  return match[1];
};
async function fixture() {
  const visit = await createVisit(patient, {
    specialty: "General practice",
    locationId: locationIds.lagos,
    preferredTime: "2099-10-01T10:00",
  });
  const bid = await submitBid(doctor, visit.id, {
    price: "75.50",
    note: "Available at the requested time.",
  });
  return { visit, bid };
}
function event(attempt: { id: string; amount: number }): PaymentEvent {
  return {
    eventId: randomUUID(),
    attemptId: attempt.id,
    amount: attempt.amount,
    currency: "USD",
    outcome: "succeeded",
  };
}
beforeAll(async () => {
  await db.webhookEvent.deleteMany();
  await db.paymentAttempt.deleteMany();
  await db.transition.deleteMany();
  await db.visit.updateMany({ data: { selectedBidId: null } });
  await db.bid.deleteMany();
  await db.visit.deleteMany();
  await db.user.deleteMany();
  await db.session.deleteMany();
  await db.mockPayment.deleteMany();
  const passwordHash = await hash("DemoPass123!", 4);
  patient = await db.user.create({
    data: {
      email: "patient@test.local",
      name: "Patient",
      role: "patient",
      passwordHash,
    },
  });
  otherPatient = await db.user.create({
    data: {
      email: "other@test.local",
      name: "Other",
      role: "patient",
      passwordHash,
    },
  });
  doctor = await db.user.create({
    data: {
      email: "doctor@test.local",
      name: "Doctor",
      role: "doctor",
      passwordHash,
    },
  });
  otherDoctor = await db.user.create({
    data: {
      email: "doctor2@test.local",
      name: "Doctor Two",
      role: "doctor",
      passwordHash,
    },
  });
  const locations = await db.location.findMany({
    where: { active: true },
    select: { id: true, slug: true },
  });
  locationIds = Object.fromEntries(
    locations.map((location) => [location.slug, location.id]),
  );
  await db.doctorLocation.createMany({
    data: [doctor, otherDoctor].flatMap((d) =>
      locations.map((location) => ({
        doctorId: d.id,
        locationId: location.id,
      })),
    ),
  });
});
afterAll(() => db.$disconnect());
test("records the full lifecycle and correct assignment through HTTP webhook", async () => {
  const { visit, bid } = await fixture();
  const attempt = await selectAndPay(patient, visit.id, bid.id);
  await request(app)
    .post("/webhooks/payment")
    .set("Authorization", auth())
    .send(event(attempt))
    .expect(200);
  const saved = await db.visit.findUniqueOrThrow({
    where: { id: visit.id },
    include: { history: { orderBy: { id: "asc" } } },
  });
  expect(saved.status).toBe("assigned");
  expect(saved.assignedDoctorId).toBe(doctor.id);
  expect(saved.history.map((h) => h.status)).toEqual([
    "open",
    "bidding",
    "paid",
    "assigned",
  ]);
});
test("duplicate and concurrent webhook confirmations have exactly one effect", async () => {
  const { visit, bid } = await fixture();
  const attempt = await selectAndPay(patient, visit.id, bid.id);
  const payload = event(attempt);
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app)
        .post("/webhooks/payment")
        .set("Authorization", auth())
        .send(payload),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(
    await db.webhookEvent.count({ where: { attemptId: attempt.id } }),
  ).toBe(1);
  expect(
    await db.transition.count({
      where: { visitId: visit.id, status: "assigned" },
    }),
  ).toBe(1);
  await confirmPayment({ ...payload, eventId: randomUUID() });
  expect(
    await db.transition.count({
      where: { visitId: visit.id, status: "assigned" },
    }),
  ).toBe(1);
});
test("decline permits a new attempt, while late duplicates do not affect the retry", async () => {
  const { visit, bid } = await fixture();
  const first = await selectAndPay(patient, visit.id, bid.id);
  const declined = { ...event(first), outcome: "declined" as const };
  await confirmPayment(declined);
  expect(
    (await db.visit.findUniqueOrThrow({ where: { id: visit.id } })).status,
  ).toBe("bidding");
  const second = await selectAndPay(patient, visit.id, bid.id);
  expect(second.id).not.toBe(first.id);
  await confirmPayment(declined);
  await confirmPayment(event(second));
  await expect(
    confirmPayment({
      ...declined,
      eventId: randomUUID(),
      outcome: "succeeded",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.visit.findUniqueOrThrow({ where: { id: visit.id } }))
      .assignedDoctorId,
  ).toBe(doctor.id);
});
test("a decline reopens selection so another doctor can be chosen", async () => {
  const { visit, bid: riveraBid } = await fixture();
  const morganBid = await submitBid(otherDoctor, visit.id, {
    price: "80.25",
    note: "I can take this appointment.",
  });
  const first = await selectAndPay(patient, visit.id, riveraBid.id);
  const declined = { ...event(first), outcome: "declined" as const };
  await confirmPayment(declined);
  const reopened = await db.visit.findUniqueOrThrow({
    where: { id: visit.id },
  });
  expect(reopened.status).toBe("bidding");
  expect(reopened.selectedBidId).toBeNull();
  const second = await selectAndPay(patient, visit.id, morganBid.id);
  expect(second.bidId).toBe(morganBid.id);
  await confirmPayment(event(second));
  const assigned = await db.visit.findUniqueOrThrow({
    where: { id: visit.id },
  });
  expect(assigned.assignedDoctorId).toBe(otherDoctor.id);
});
test("a new doctor can bid after decline, and the old decline cannot clear the new selection", async () => {
  const { visit, bid } = await fixture();
  const first = await selectAndPay(patient, visit.id, bid.id);
  const declined = { ...event(first), outcome: "declined" as const };
  await confirmPayment(declined);
  const lateDecline = { ...declined, eventId: randomUUID() };
  const newBid = await submitBid(otherDoctor, visit.id, {
    price: "95",
    note: "Newly available after decline.",
  });
  const second = await selectAndPay(patient, visit.id, newBid.id);
  await confirmPayment(lateDecline);
  expect(
    (await db.visit.findUniqueOrThrow({ where: { id: visit.id } }))
      .selectedBidId,
  ).toBe(newBid.id);
  await expect(
    confirmPayment({
      ...declined,
      eventId: randomUUID(),
      outcome: "succeeded",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await confirmPayment(event(second));
  expect(
    (await db.visit.findUniqueOrThrow({ where: { id: visit.id } }))
      .assignedDoctorId,
  ).toBe(otherDoctor.id);
});
test("concurrent checkout submissions reuse one pending attempt", async () => {
  const { visit, bid } = await fixture();
  const attempts = await Promise.all(
    Array.from({ length: 5 }, () => selectAndPay(patient, visit.id, bid.id)),
  );
  expect(new Set(attempts.map((a) => a.id)).size).toBe(1);
  expect(await db.paymentAttempt.count({ where: { visitId: visit.id } })).toBe(
    1,
  );
});
test("selection locks bids and rejects competing choices", async () => {
  const { visit, bid } = await fixture();
  const second = await submitBid(otherDoctor, visit.id, {
    price: "90",
    note: "Alternative",
  });
  const results = await Promise.allSettled([
    selectAndPay(patient, visit.id, bid.id),
    selectAndPay(patient, visit.id, second.id),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(
    submitBid(doctor, visit.id, { price: "30", note: "Late bid" }),
  ).rejects.toMatchObject({ status: 409 });
});
test("rejects foreign ownership, wrong roles, duplicate bids and mismatched bid IDs", async () => {
  const { visit, bid } = await fixture();
  const other = await fixture();
  await expect(
    selectAndPay(otherPatient, visit.id, bid.id),
  ).rejects.toMatchObject({ status: 403 });
  await expect(selectAndPay(doctor, visit.id, bid.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(
    submitBid(patient, visit.id, { price: "1", note: "x" }),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    submitBid(doctor, visit.id, { price: "1", note: "x" }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    selectAndPay(patient, visit.id, other.bid.id),
  ).rejects.toMatchObject({ status: 400 });
});
test("rejects invalid callbacks without recording effects", async () => {
  const { visit, bid } = await fixture();
  const attempt = await selectAndPay(patient, visit.id, bid.id);
  const payload = event(attempt);
  await request(app).post("/webhooks/payment").send(payload).expect(401);
  await request(app)
    .post("/webhooks/payment")
    .set("Authorization", auth())
    .send({ ...payload, amount: 1 })
    .expect(400);
  await request(app)
    .post("/webhooks/payment")
    .set("Authorization", auth())
    .send({ ...payload, currency: "EUR" })
    .expect(400);
  await request(app)
    .post("/webhooks/payment")
    .set("Authorization", auth())
    .send({ ...payload, attemptId: randomUUID() })
    .expect(404);
  expect(
    await db.webhookEvent.count({ where: { attemptId: attempt.id } }),
  ).toBe(0);
  await confirmPayment(payload);
  await expect(
    confirmPayment({ ...payload, outcome: "declined" }),
  ).rejects.toMatchObject({ status: 409 });
});
test("transaction failure rolls back event and payment, and delivery can be retried", async () => {
  const { visit, bid } = await fixture();
  const attempt = await selectAndPay(patient, visit.id, bid.id);
  const payload = event(attempt);
  // Force the guarded transition to fail AFTER the transaction writes the event and payment.
  await db.visit.update({ where: { id: visit.id }, data: { status: "open" } });
  await expect(confirmPayment(payload)).rejects.toMatchObject({ status: 409 });
  expect(
    await db.webhookEvent.findUnique({ where: { id: payload.eventId } }),
  ).toBeNull();
  expect(
    (await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
      .status,
  ).toBe("pending");
  expect(
    await db.transition.count({ where: { visitId: visit.id, status: "paid" } }),
  ).toBe(0);
  await db.visit.update({
    where: { id: visit.id },
    data: { status: "bidding" },
  });
  await confirmPayment(payload);
  expect(
    (await db.visit.findUniqueOrThrow({ where: { id: visit.id } })).status,
  ).toBe("assigned");
});
test("SSR login, CSRF, ownership, request creation and logout", async () => {
  const agent = request.agent(app);
  await agent.get("/").expect(302);
  const login = await agent.get("/login").expect(200);
  for (const account of DEMO_ACCOUNTS)
    expect(login.text).toContain(account.email);
  await agent
    .post("/login")
    .send({ email: "patient@test.local", password: "DemoPass123!" })
    .expect(403);
  await agent
    .post("/login")
    .type("form")
    .send({
      _csrf: csrf(login.text),
      email: "patient@test.local",
      password: "DemoPass123!",
    })
    .expect(303);
  const form = await agent.get("/visits/new").expect(200);
  const created = await agent
    .post("/visits")
    .type("form")
    .send({
      _csrf: csrf(form.text),
      specialty: "Dermatology",
      locationId: locationIds.abuja,
      preferredTime: "2099-11-01T12:00",
    })
    .expect(303);
  expect(
    (await agent.get(created.headers.location).expect(200)).text,
  ).toContain("Dermatology");
  const privateVisit = await createVisit(otherPatient, {
    specialty: "Private",
    locationId: locationIds.abuja,
    preferredTime: "2099-11-01T12:00",
  });
  await agent.get(`/visits/${privateVisit.id}`).expect(403);
  await agent
    .post("/logout")
    .type("form")
    .send({ _csrf: csrf(form.text) })
    .expect(303);
  await agent.get("/").expect(302);
});
test("SSR visit notices are scoped to the patient and assigned doctor", async () => {
  const visit = await createVisit(patient, {
    specialty: "Notice coverage",
    locationId: locationIds.abuja,
    preferredTime: "2099-12-01T12:00",
  });
  const winningBid = await submitBid(doctor, visit.id, {
    price: "90",
    note: "Ready to help.",
  });
  await submitBid(otherDoctor, visit.id, {
    price: "95",
    note: "Also available.",
  });
  const attempt = await selectAndPay(patient, visit.id, winningBid.id);
  await confirmPayment(event(attempt));

  async function loggedIn(email: string) {
    const agent = request.agent(app);
    const login = await agent.get("/login").expect(200);
    await agent
      .post("/login")
      .type("form")
      .send({
        _csrf: csrf(login.text),
        email,
        password: "DemoPass123!",
      })
      .expect(303);
    return agent;
  }

  const patientPage = await (await loggedIn("patient@test.local"))
    .get(`/visits/${visit.id}`)
    .expect(200);
  expect(patientPage.text).toContain("Confirmed! Your visit is assigned to");

  const winningDoctorPage = await (await loggedIn("doctor@test.local"))
    .get(`/visits/${visit.id}`)
    .expect(200);
  expect(winningDoctorPage.text).toContain("This visit is assigned to you.");
  expect(winningDoctorPage.text).not.toContain(
    "Confirmed! Your visit is assigned to",
  );

  const otherDoctorPage = await (await loggedIn("doctor2@test.local"))
    .get(`/visits/${visit.id}`)
    .expect(200);
  expect(otherDoctorPage.text).not.toContain(
    "Confirmed! Your visit is assigned to",
  );
  expect(otherDoctorPage.text).not.toContain("This visit is assigned to you.");
});
test("mock creation is idempotent and saved outcomes survive failed delivery and resend", async () => {
  const mock = createMockApp();
  const data = { attemptId: randomUUID(), amount: 3000, currency: "USD" };
  await request(mock).post("/api/payments").send(data).expect(401);
  const first = await request(mock)
    .post("/api/payments")
    .set("Authorization", auth())
    .send(data)
    .expect(200);
  const again = await request(mock)
    .post("/api/payments")
    .set("Authorization", auth())
    .send(data)
    .expect(200);
  expect(again.body).toEqual(first.body);
  await request(mock)
    .post("/api/payments")
    .set("Authorization", auth())
    .send({ ...data, amount: 1 })
    .expect(409);
  const path = new URL(first.body.checkoutUrl).pathname;
  const checkout = await request(mock).get(path).expect(200);
  const fetchMock = jest
    .spyOn(global, "fetch")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ ok: true } as Response);
  try {
    const failed = await request(mock)
      .post(path)
      .type("form")
      .send({ _csrf: csrf(checkout.text), outcome: "declined" })
      .expect(200);
    expect(failed.text).toContain("Delivery failed");
    const saved = await db.mockPayment.findUniqueOrThrow({
      where: { id: data.attemptId },
    });
    expect(saved.status).toBe("declined");
    await request(mock)
      .post(path)
      .type("form")
      .send({ _csrf: csrf(checkout.text), outcome: "succeeded" })
      .expect(200);
    expect(
      (
        await db.mockPayment.findUniqueOrThrow({
          where: { id: data.attemptId },
        })
      ).status,
    ).toBe("declined");
    await request(mock)
      .post(path)
      .type("form")
      .send({ _csrf: csrf(checkout.text), outcome: "resend" })
      .expect(200);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(c[1]!.body as string),
    );
    expect(new Set(bodies.map((b) => b.eventId)).size).toBe(1);
    expect(bodies.every((b) => b.outcome === "declined")).toBe(true);
  } finally {
    fetchMock.mockRestore();
  }
});

test("mock concurrent creation returns one checkout", async () => {
  const mock = createMockApp();
  const data = { attemptId: randomUUID(), amount: 4200, currency: "USD" };
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(mock)
        .post("/api/payments")
        .set("Authorization", auth())
        .send(data),
    ),
  );
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(new Set(results.map((r) => r.body.checkoutUrl)).size).toBe(1);
});

test("validates future request time and exact minor-unit prices", async () => {
  await expect(
    createVisit(patient, {
      specialty: "GP",
      locationId: locationIds.lagos,
      preferredTime: "2020-01-01T12:00",
    }),
  ).rejects.toHaveProperty("issues");
  await expect(
    createVisit(patient, {
      specialty: "GP",
      locationId: randomUUID(),
      preferredTime: "2099-01-01T12:00",
    }),
  ).rejects.toMatchObject({ status: 400 });
  const visit = await createVisit(patient, {
    specialty: "GP",
    locationId: locationIds.lagos,
    preferredTime: "2099-01-01T12:00",
  });
  await expect(
    submitBid(doctor, visit.id, { price: "0", note: "No fee" }),
  ).rejects.toHaveProperty("issues");
  await expect(
    submitBid(doctor, visit.id, { price: "10.001", note: "Invalid precision" }),
  ).rejects.toHaveProperty("issues");
  const bid = await submitBid(doctor, visit.id, {
    price: "10.01",
    note: "Exact cents",
  });
  expect(bid.amount).toBe(1001);
});

test("matches open visits by location and enforces the rule server-side", async () => {
  const lagos = await db.location.findUniqueOrThrow({
    where: { slug: "lagos" },
  });
  const abuja = await db.location.findUniqueOrThrow({
    where: { slug: "abuja" },
  });
  await updateDoctorLocations(doctor, { locationIds: [lagos.id] });
  await updateDoctorLocations(otherDoctor, { locationIds: [abuja.id] });
  const visit = await createVisit(patient, {
    specialty: "Location matching",
    locationId: lagos.id,
    preferredTime: "2099-02-01T12:00",
  });

  await expect(
    submitBid(otherDoctor, visit.id, {
      price: "50",
      note: "Outside my service area",
    }),
  ).rejects.toMatchObject({ status: 403 });
  await submitBid(doctor, visit.id, {
    price: "55",
    note: "I cover Lagos.",
  });

  async function loggedIn(email: string) {
    const agent = request.agent(app);
    const login = await agent.get("/login").expect(200);
    await agent
      .post("/login")
      .type("form")
      .send({
        _csrf: csrf(login.text),
        email,
        password: "DemoPass123!",
      })
      .expect(303);
    return agent;
  }

  const otherDashboard = await (await loggedIn("doctor2@test.local"))
    .get("/")
    .expect(200);
  expect(otherDashboard.text).not.toContain("Location matching");
  await (await loggedIn("doctor2@test.local"))
    .get(`/visits/${visit.id}`)
    .expect(403);
});

test("doctor service areas require active catalog locations and at least one selection", async () => {
  const lagos = await db.location.findUniqueOrThrow({
    where: { slug: "lagos" },
  });
  await expect(
    updateDoctorLocations(doctor, { locationIds: [] }),
  ).rejects.toHaveProperty("issues");
  await expect(
    updateDoctorLocations(doctor, { locationIds: [lagos.id, lagos.id] }),
  ).rejects.toMatchObject({ status: 400 });
  const saved = await updateDoctorLocations(doctor, {
    locationIds: [lagos.id],
  });
  expect(saved.map((link) => link.location.slug)).toEqual(["lagos"]);
});

test("renders service-area settings and warns patients about uncovered requests", async () => {
  const newYork = await db.location.findUniqueOrThrow({
    where: { slug: "new-york" },
  });
  const legacy = await db.location.findUniqueOrThrow({
    where: { slug: "legacy-location" },
  });
  const doctorAgent = request.agent(app);
  const doctorLogin = await doctorAgent.get("/login").expect(200);
  await doctorAgent
    .post("/login")
    .type("form")
    .send({
      _csrf: csrf(doctorLogin.text),
      email: "doctor@test.local",
      password: "DemoPass123!",
    })
    .expect(303);
  const settings = await doctorAgent.get("/settings/locations").expect(200);
  expect(settings.text).toContain("Your service areas");
  expect(settings.text).toContain("Lagos, Nigeria");
  await doctorAgent
    .post("/settings/locations")
    .type("form")
    .send({
      _csrf: csrf(settings.text),
      locationIds: locationIds.lagos,
    })
    .expect(303)
    .expect("Location", "/settings/locations");
  const savedSettings = await doctorAgent
    .get("/settings/locations")
    .expect(200);
  expect(savedSettings.text).toContain(
    '<p class="notice" role="status">Service areas updated successfully.</p>',
  );
  expect(
    (await doctorAgent.get("/settings/locations").expect(200)).text,
  ).not.toContain("Service areas updated successfully.");

  const duplicateSettings = await doctorAgent
    .get("/settings/locations")
    .expect(200);
  const duplicate = await doctorAgent
    .post("/settings/locations")
    .type("form")
    .send({
      _csrf: csrf(duplicateSettings.text),
      locationIds: [locationIds.lagos, locationIds.lagos],
    })
    .expect(400);
  expect(duplicate.text).toContain("Choose each service area only once.");
  expect(duplicate.text).toContain(`value="${locationIds.lagos}" checked`);

  const inactiveSettings = await doctorAgent
    .get("/settings/locations")
    .expect(200);
  const inactive = await doctorAgent
    .post("/settings/locations")
    .type("form")
    .send({
      _csrf: csrf(inactiveSettings.text),
      locationIds: [locationIds.lagos, legacy.id],
    })
    .expect(400);
  expect(inactive.text).toContain("One or more service areas are unavailable.");
  expect(inactive.text).toContain(`value="${locationIds.lagos}" checked`);

  const visit = await createVisit(patient, {
    specialty: "Uncovered area",
    locationId: newYork.id,
    preferredTime: "2099-03-01T12:00",
  });
  const patientAgent = request.agent(app);
  const patientLogin = await patientAgent.get("/login").expect(200);
  await patientAgent
    .post("/login")
    .type("form")
    .send({
      _csrf: csrf(patientLogin.text),
      email: "patient@test.local",
      password: "DemoPass123!",
    })
    .expect(303);
  expect((await patientAgent.get("/visits/new").expect(200)).text).toContain(
    "Choose a city or region",
  );
  expect(
    (await patientAgent.get(`/visits/${visit.id}`).expect(200)).text,
  ).toContain("No doctors currently cover this area");
});
