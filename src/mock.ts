import express from "express";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { secret, appUrl, mockPublicUrl } from "./config";
import { equal, security, errors } from "./http";
import { HttpError } from "./services";
export function createMockApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", "views");
  app.use(security);
  app.use("/style.css", express.static("public/style.css"));
  app.get("/checkout.js", (_req, res) => {
    res.sendFile("checkout.js", { root: "public" });
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use((_req, res, next) => {
    res.locals.user = null;
    res.locals.csrf = "";
    res.locals.money = (n: number) => `$${(n / 100).toFixed(2)}`;
    next();
  });
  app.get("/", (_req, res) => res.redirect(appUrl));
  app.get("/health", async (_req, res) => {
    await db.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });
  app.post("/api/payments", async (req, res) => {
    if (!equal(req.headers.authorization, `Bearer ${secret("PAYMENT_SECRET")}`))
      throw new HttpError(401, "Invalid authentication.");
    const data = z
      .object({
        attemptId: z.string().uuid(),
        amount: z.number().int().positive(),
        currency: z.literal("USD"),
      })
      .parse(req.body);
    await db.mockPayment.createMany({
      data: {
        id: data.attemptId,
        amount: data.amount,
        currency: data.currency,
        token: randomBytes(32).toString("hex"),
        eventId: randomUUID(),
      },
      skipDuplicates: true,
    });
    const payment = await db.mockPayment.findUniqueOrThrow({
      where: { id: data.attemptId },
    });
    if (payment.amount !== data.amount || payment.currency !== data.currency)
      throw new HttpError(
        409,
        "Payment identifier reused with different data.",
      );
    res.json({
      checkoutUrl: `${mockPublicUrl}/checkout/${payment.token}`,
    });
  });
  app.get("/checkout/:token", async (req, res) => {
    const payment = await db.mockPayment.findUnique({
      where: { token: req.params.token },
    });
    if (!payment) throw new HttpError(404, "Checkout not found.");
    res.render("checkout", {
      title: "Mock checkout",
      payment,
      message: null,
      appUrl,
    });
  });
  app.post("/checkout/:token", async (req, res) => {
    if (!equal(req.body?._csrf, req.params.token))
      throw new HttpError(403, "Invalid checkout form.");
    const outcome = z
      .enum(["succeeded", "declined", "resend"])
      .parse(req.body.outcome);
    const payment = await db.mockPayment.findUnique({
      where: { token: req.params.token },
    });
    if (!payment) throw new HttpError(404, "Checkout not found.");
    if (outcome === "resend" && payment.status === "pending")
      throw new HttpError(409, "Choose a payment outcome first.");
    if (outcome !== "resend")
      await db.mockPayment.updateMany({
        where: { id: payment.id, status: "pending" },
        data: { status: outcome },
      });
    const saved = await db.mockPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    let delivered = false;
    try {
      const response = await fetch(
        `${process.env.WEBHOOK_URL ?? "http://app:3000/webhooks/payment"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${secret("PAYMENT_SECRET")}`,
          },
          body: JSON.stringify({
            eventId: saved.eventId,
            attemptId: saved.id,
            outcome: saved.status,
            amount: saved.amount,
            currency: saved.currency,
          }),
          signal: AbortSignal.timeout(5000),
        },
      );
      delivered = response.ok;
    } catch {
      /* Persisted outcome can be resent after a network failure. */
    }
    res.render("checkout", {
      title: "Payment result",
      payment: saved,
      message: delivered
        ? "Confirmation delivered. Re-sending it is safe."
        : "Delivery failed. The outcome is saved; use Resend confirmation to retry.",
      appUrl,
    });
  });
  app.use((_req, _res, next) => next(new HttpError(404, "Page not found.")));
  app.use(errors);
  return app;
}
