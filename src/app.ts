import express from "express";
import session from "express-session";
import { randomBytes } from "node:crypto";
import { compare } from "bcryptjs";
import { ZodError, z } from "zod";
import { db } from "./db";
import { secret, mockUrl } from "./config";
import { MysqlSessionStore } from "./session-store";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "./demo-accounts";
import { equal, errors, security } from "./http";
import {
  createVisit,
  submitBid,
  selectAndPay,
  confirmPayment,
  eventInput,
  HttpError,
  getDoctorLocations,
  listActiveLocations,
  updateDoctorLocations,
} from "./services";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", "views");
  app.use(security);
  app.use("/style.css", express.static("public/style.css"));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });
  app.post("/webhooks/payment", async (req, res) => {
    if (!equal(req.headers.authorization, `Bearer ${secret("PAYMENT_SECRET")}`))
      throw new HttpError(401, "Invalid webhook authentication.");
    res.json(await confirmPayment(eventInput.parse(req.body)));
  });
  app.use(
    session({
      secret: secret("SESSION_SECRET"),
      store: new MysqlSessionStore(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.COOKIE_SECURE === "true",
        maxAge: 86400000,
      },
    }),
  );
  app.use(async (req, res, next) => {
    req.session.csrf ??= randomBytes(32).toString("hex");
    res.locals.csrf = req.session.csrf;
    res.locals.user = req.session.userId
      ? await db.user.findUnique({
          where: { id: req.session.userId },
          select: { id: true, name: true, role: true },
        })
      : null;
    res.locals.money = (amount: number) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(amount / 100);
    res.locals.time = (date: Date) =>
      date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
    if (req.method === "POST" && !equal(req.body?._csrf, req.session.csrf))
      throw new HttpError(
        403,
        "Your form expired. Reload the page and try again.",
      );
    next();
  });
  app.get("/login", (_req, res) =>
    res.render("login", {
      title: "Welcome back",
      error: null,
      demoAccounts: DEMO_ACCOUNTS,
      demoPassword: DEMO_PASSWORD,
    }),
  );
  app.post("/login", async (req, res, next) => {
    const input = z
      .object({
        email: z.string().email(),
        password: z.string().min(1).max(100),
      })
      .parse(req.body);
    const user = await db.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    if (!user || !(await compare(input.password, user.passwordHash))) {
      res.status(401).render("login", {
        title: "Welcome back",
        error: "Incorrect email or password.",
        demoAccounts: DEMO_ACCOUNTS,
        demoPassword: DEMO_PASSWORD,
      });
      return;
    }
    req.session.regenerate((err) => {
      if (err) {
        next(err);
        return;
      }
      req.session.userId = user.id;
      req.session.save((err) => (err ? next(err) : res.redirect(303, "/")));
    });
  });
  app.use((_req, res, next) => {
    if (!res.locals.user) {
      res.redirect("/login");
      return;
    }
    next();
  });
  app.post("/logout", (req, res, next) =>
    req.session.destroy((err) => {
      if (err) {
        next(err);
        return;
      }
      res.clearCookie("connect.sid");
      res.redirect(303, "/login");
    }),
  );
  app.get("/", async (_req, res) => {
    const user = res.locals.user;
    const visits = await db.visit.findMany({
      where:
        user.role === "patient"
          ? { patientId: user.id }
          : {
              OR: [
                {
                  status: { in: ["open", "bidding"] },
                  selectedBidId: null,
                  locationRef: {
                    doctorLocations: {
                      some: {
                        doctorId: user.id,
                        location: { active: true },
                      },
                    },
                  },
                },
                { assignedDoctorId: user.id },
                { bids: { some: { doctorId: user.id } } },
              ],
            },
      include: { _count: { select: { bids: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.render("dashboard", {
      title: user.role === "patient" ? "Your visits" : "Doctor dashboard",
      visits,
    });
  });
  app.get("/visits/new", async (_req, res) => {
    if (res.locals.user.role !== "patient")
      throw new HttpError(403, "Only patients can request visits.");
    res.render("new-visit", {
      title: "Request a visit",
      locations: await listActiveLocations(),
    });
  });
  app.get("/settings/locations", async (req, res) => {
    if (res.locals.user.role !== "doctor")
      throw new HttpError(403, "Only doctors can manage service areas.");
    const notice = req.session.locationNotice;
    delete req.session.locationNotice;
    const [locations, selected] = await Promise.all([
      listActiveLocations(),
      getDoctorLocations(res.locals.user),
    ]);
    res.render("locations", {
      title: "Service areas",
      locations,
      selectedLocationIds: new Set(selected.map((link) => link.locationId)),
      notice,
      error: null,
    });
  });
  app.post("/settings/locations", async (req, res, next) => {
    try {
      await updateDoctorLocations(res.locals.user, req.body);
      req.session.locationNotice = "Service areas updated successfully.";
      res.redirect(303, "/settings/locations");
    } catch (err) {
      const expected =
        err instanceof ZodError ||
        (err instanceof HttpError && err.status === 400);
      if (!expected) {
        next(err);
        return;
      }
      const rawIds = req.body?.locationIds;
      const selectedLocationIds = new Set(
        (Array.isArray(rawIds)
          ? rawIds
          : typeof rawIds === "string"
            ? [rawIds]
            : []
        ).filter((id): id is string => typeof id === "string"),
      );
      const locations = await listActiveLocations();
      const message =
        err instanceof ZodError
          ? err.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join(" ")
          : err.message;
      res.status(400).render("locations", {
        title: "Service areas",
        locations,
        selectedLocationIds,
        notice: null,
        error: message,
      });
    }
  });
  app.post("/visits", async (req, res) => {
    const visit = await createVisit(res.locals.user, req.body);
    res.redirect(303, `/visits/${visit.id}`);
  });
  app.get("/visits/:id", async (req, res) => {
    const visit = await db.visit.findUnique({
      where: { id: req.params.id },
      include: {
        bids: {
          include: { doctor: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        },
        payments: { orderBy: { createdAt: "desc" } },
        history: { orderBy: { id: "asc" } },
        assignedDoctor: { select: { name: true } },
        locationRef: {
          include: { _count: { select: { doctorLocations: true } } },
        },
      },
    });
    if (!visit) throw new HttpError(404, "Visit not found.");
    const user = res.locals.user;
    if (user.role === "patient" && visit.patientId !== user.id)
      throw new HttpError(403, "This is not your visit.");
    if (user.role === "doctor") {
      const ownsBid = visit.bids.some((b) => b.doctorId === user.id);
      const isAssigned = visit.assignedDoctorId === user.id;
      const coversLocation =
        ["open", "bidding"].includes(visit.status) &&
        (
          await db.doctorLocation.findUnique({
            where: {
              doctorId_locationId: {
                doctorId: user.id,
                locationId: visit.locationId,
              },
            },
            include: { location: { select: { active: true } } },
          })
        )?.location.active === true;
      if (!ownsBid && !isAssigned && !coversLocation)
        throw new HttpError(403, "This visit is not available.");
    }
    if (user.role === "doctor") {
      visit.bids = visit.bids.filter((b) => b.doctorId === user.id);
      visit.payments = [];
    }
    res.render("visit", { title: visit.specialty, visit });
  });
  app.post("/visits/:id/bids", async (req, res) => {
    await submitBid(res.locals.user, req.params.id, req.body);
    res.redirect(303, `/visits/${req.params.id}`);
  });
  app.post("/visits/:id/pay", async (req, res) => {
    const { bidId } = z.object({ bidId: z.string().uuid() }).parse(req.body);
    const attempt = await selectAndPay(res.locals.user, req.params.id, bidId);
    let response: Response;
    try {
      response = await fetch(`${mockUrl}/api/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret("PAYMENT_SECRET")}`,
        },
        body: JSON.stringify({
          attemptId: attempt.id,
          amount: attempt.amount,
          currency: attempt.currency,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new HttpError(
        503,
        "Checkout is temporarily unavailable. Return to the visit and retry; your selected bid is saved.",
      );
    }
    if (!response.ok)
      throw new HttpError(
        503,
        "Checkout is temporarily unavailable. Retry from the visit.",
      );
    const result = z
      .object({ checkoutUrl: z.string().url() })
      .parse(await response.json());
    res.redirect(303, result.checkoutUrl);
  });
  app.use((_req, _res, next) => next(new HttpError(404, "Page not found.")));
  app.use(errors);
  return app;
}
