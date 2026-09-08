import { Prisma, Role } from "@prisma/client";
import { z } from "zod";
import { db } from "./db";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Actor = { id: string; role: Role };
export function requireRole(actor: Actor, role: Role) {
  if (actor.role !== role)
    throw new HttpError(403, "This action is not available for your role.");
}
export const requestInput = z.object({
  specialty: z.string().trim().min(2).max(100),
  location: z.string().trim().min(2).max(200),
  preferredTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .transform((s) => new Date(`${s}:00Z`))
    .refine(
      (d) => Number.isFinite(d.getTime()) && d > new Date(),
      "Choose a future time (UTC).",
    ),
});
export const bidInput = z.object({
  price: z
    .string()
    .regex(
      /^\d{1,5}(\.\d{1,2})?$/,
      "Enter a USD price with at most two decimal places.",
    )
    .transform((s) => {
      const [whole, cents = ""] = s.split(".");
      return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
    })
    .refine((n) => n > 0 && n <= 10000000),
  note: z.string().trim().min(1).max(500),
});
export const eventInput = z
  .object({
    eventId: z.string().uuid(),
    attemptId: z.string().uuid(),
    outcome: z.enum(["succeeded", "declined"]),
    amount: z.number().int().positive(),
    currency: z.literal("USD"),
  })
  .strict();
export type PaymentEvent = z.infer<typeof eventInput>;
// Every operation that changes a booking locks the visit first, in the same order.
// READ COMMITTED ensures reads after waiting for that lock see the preceding commit.
// In particular, a webhook must not retain a snapshot from its initial attempt lookup.
async function lockVisit(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM Visit WHERE id = ${id} FOR UPDATE`;
  const visit = await tx.visit.findUnique({
    where: { id },
    include: { selectedBid: true },
  });
  if (!visit) throw new HttpError(404, "Visit not found.");
  return visit;
}
export async function createVisit(actor: Actor, raw: unknown) {
  requireRole(actor, "patient");
  const data = requestInput.parse(raw);
  return db.visit.create({
    data: {
      ...data,
      patientId: actor.id,
      history: { create: { status: "open" } },
    },
  });
}
export async function submitBid(actor: Actor, visitId: string, raw: unknown) {
  requireRole(actor, "doctor");
  const input = bidInput.parse(raw);
  return db.$transaction(
    async (tx) => {
      const v = await lockVisit(tx, visitId);
      if (v.selectedBidId || !["open", "bidding"].includes(v.status))
        throw new HttpError(409, "This visit is no longer accepting bids.");
      if (
        await tx.bid.findUnique({
          where: { visitId_doctorId: { visitId, doctorId: actor.id } },
        })
      )
        throw new HttpError(409, "You have already bid on this visit.");
      const bid = await tx.bid.create({
        data: {
          visitId,
          doctorId: actor.id,
          amount: input.price,
          note: input.note,
        },
      });
      if (v.status === "open")
        await tx.visit.update({
          where: { id: visitId },
          data: {
            status: "bidding",
            history: { create: { status: "bidding" } },
          },
        });
      return bid;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
export async function selectAndPay(
  actor: Actor,
  visitId: string,
  bidId: string,
) {
  requireRole(actor, "patient");
  return db.$transaction(
    async (tx) => {
      const v = await lockVisit(tx, visitId);
      if (v.patientId !== actor.id)
        throw new HttpError(403, "This is not your visit.");
      if (v.status !== "bidding")
        throw new HttpError(409, "This visit cannot be paid now.");
      const bid = await tx.bid.findUnique({ where: { id: bidId } });
      if (!bid || bid.visitId !== visitId)
        throw new HttpError(400, "Bid does not belong to this visit.");
      const pending = await tx.paymentAttempt.findUnique({
        where: { pendingVisitId: visitId },
      });
      if (pending && (v.selectedBidId !== bidId || pending.bidId !== bidId))
        throw new HttpError(409, "The selected bid is locked.");
      if (v.selectedBidId !== bid.id)
        await tx.visit.update({
          where: { id: visitId },
          data: { selectedBidId: bid.id },
        });
      return (
        pending ??
        tx.paymentAttempt.create({
          data: {
            visitId,
            bidId: bid.id,
            amount: bid.amount,
            currency: bid.currency,
            pendingVisitId: visitId,
          },
        })
      );
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
export async function confirmPayment(event: PaymentEvent) {
  return db.$transaction(
    async (tx) => {
      const attempt = await tx.paymentAttempt.findUnique({
        where: { id: event.attemptId },
        include: { bid: true },
      });
      if (!attempt) throw new HttpError(404, "Unknown payment attempt.");
      const visit = await lockVisit(tx, attempt.visitId);
      const current = await tx.paymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
        include: { bid: true },
      });
      if (
        current.amount !== event.amount ||
        current.currency !== event.currency
      )
        throw new HttpError(400, "Payment does not match the selected bid.");
      const previous = await tx.webhookEvent.findUnique({
        where: { id: event.eventId },
      });
      if (previous) {
        if (
          previous.attemptId !== event.attemptId ||
          previous.outcome !== event.outcome ||
          previous.amount !== event.amount ||
          previous.currency !== event.currency
        )
          throw new HttpError(
            409,
            "Event identifier reused with different data.",
          );
        return { duplicate: true };
      }
      if (current.status !== "pending") {
        if (current.status !== event.outcome)
          throw new HttpError(409, "Payment outcome is already final.");
        await tx.webhookEvent.create({
          data: {
            id: event.eventId,
            attemptId: event.attemptId,
            outcome: event.outcome,
            amount: event.amount,
            currency: event.currency,
          },
        });
        return { duplicate: true };
      }
      if (
        visit.selectedBidId !== current.bidId ||
        current.bid.amount !== current.amount ||
        current.bid.currency !== current.currency
      )
        throw new HttpError(409, "This payment attempt is no longer selected.");
      await tx.webhookEvent.create({
        data: {
          id: event.eventId,
          attemptId: event.attemptId,
          outcome: event.outcome,
          amount: event.amount,
          currency: event.currency,
        },
      });
      if (current.status !== "pending") return { duplicate: true };
      await tx.paymentAttempt.update({
        where: { id: current.id },
        data: { status: event.outcome, pendingVisitId: null },
      });
      if (event.outcome === "declined") {
        await tx.visit.updateMany({
          where: {
            id: visit.id,
            status: "bidding",
            selectedBidId: current.bidId,
          },
          data: { selectedBidId: null },
        });
      } else {
        const changed = await tx.visit.updateMany({
          where: {
            id: visit.id,
            status: "bidding",
            selectedBidId: current.bidId,
            assignedDoctorId: null,
          },
          data: { status: "paid" },
        });
        if (changed.count !== 1)
          throw new HttpError(409, "Visit cannot be assigned.");
        await tx.transition.create({
          data: { visitId: visit.id, status: "paid" },
        });
        await tx.visit.update({
          where: { id: visit.id },
          data: {
            status: "assigned",
            assignedDoctorId: visit.selectedBid!.doctorId,
            history: { create: { status: "assigned" } },
          },
        });
      }
      return { duplicate: false };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
