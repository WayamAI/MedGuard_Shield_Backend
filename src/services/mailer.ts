import nodemailer from "nodemailer";
import { isProduction } from "../config.js";

/**
 * One SMTP transport for every environment. In dev/test it points at
 * Mailpit (docker-compose service `mailpit`, SMTP on :1025), whose web UI and
 * HTTP API let a human — or a test — read what was "sent" without a real
 * mail provider. Production points at a real SMTP relay via env vars.
 *
 * The interface callers see (`sendMail`) never changes between the two, so
 * swapping providers later is a transport change, not a call-site change.
 */
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "localhost",
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: isProduction && process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
});

export type Mail = { to: string; subject: string; text: string };

export async function sendMail(mail: Mail): Promise<void> {
  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "Drishti <no-reply@drishti.local>",
    ...mail,
  });
}
