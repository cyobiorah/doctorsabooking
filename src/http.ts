import { timingSafeEqual } from "node:crypto";
import { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "./services";
import { mockPublicUrl } from "./config";
export function equal(a: unknown, b: string) {
  return (
    typeof a === "string" &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export const security: RequestHandler = (_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    // Browsers also apply form-action to the POST redirect into mock checkout.
    "Content-Security-Policy": `default-src 'self'; style-src 'self'; form-action 'self' ${new URL(mockPublicUrl).origin}; frame-ancestors 'none'; base-uri 'none'`,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  });
  next();
};
export const errors: ErrorRequestHandler = (err, req, res, _next) => {
  const status =
    err instanceof HttpError ? err.status : err instanceof ZodError ? 400 : 500;
  const message =
    err instanceof ZodError
      ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" ")
      : status === 500
        ? "Something went wrong. Please try again."
        : err.message;
  if (status === 500) console.error(err);
  if (req.path.startsWith("/webhooks/") || req.path.startsWith("/api/")) {
    res.status(status).json({ error: message });
    return;
  }
  res
    .status(status)
    .render("error", { title: "Unable to complete action", message });
};
