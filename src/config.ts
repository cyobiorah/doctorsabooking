import { readFileSync } from "node:fs";
export function secret(name: string): string {
  const value =
    process.env[name] ??
    (process.env.SECRETS_DIR
      ? readFileSync(`${process.env.SECRETS_DIR}/${name}`, "utf8").trim()
      : "");
  if (value.length < 32)
    throw new Error(`${name} must contain at least 32 characters`);
  return value;
}
export const appUrl = process.env.APP_URL ?? "http://localhost:3000";
export const mockUrl = process.env.MOCK_URL ?? "http://mock:3001";
export const mockPublicUrl =
  process.env.MOCK_PUBLIC_URL ?? "http://localhost:3001";
