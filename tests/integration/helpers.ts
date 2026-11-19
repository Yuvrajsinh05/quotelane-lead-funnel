import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { CURRENT_CONSENT_VERSION } from "@/domain/consent";
import type { AppConfig } from "@/server/config";
import { createDb } from "@/server/db/client";
import type { SubmitContext } from "@/server/leads/lead.service";

const url = process.env.DATABASE_URL_TEST;
if (!url) throw new Error("DATABASE_URL_TEST is not set (see .env.example). Run `npm run db:up` first.");

export const holder = createDb(url, { max: 12 });
export const db = holder.db;

export async function resetDb() {
  await db.execute(sql`truncate table delivery_attempts, partner_deliveries, consents, leads, rate_limits restart identity cascade`);
}

export const config: AppConfig = {
  DATABASE_URL: url,
  APP_SECRET: "test-secret-test-secret-test-secret-1234",
  PARTNER_WEBHOOK_URL: "http://127.0.0.1:1/unused",
  PARTNER_WEBHOOK_SECRET: "partner-signing-secret",
  PARTNER_TIMEOUT_MS: 5000,
  PARTNER_SOURCE_IDS: { default: "QL-WEB-001", email: "QL-EM-001" },
  BRAND_ID: "quotelane",
  BRAND_CLICK_PREFIX: "ql",
  CRON_SECRET: "cron",
};

let ipCounter = 0;
export function ctx(overrides: Partial<SubmitContext> = {}): SubmitContext {
  ipCounter++;
  return {
    db,
    config,
    split: { percentB: 50, valid: true },
    requestId: "test",
    ip: `203.0.113.${ipCounter % 250}`,
    userAgent: "Mozilla/5.0 (Test)",
    idempotencyKey: crypto.randomUUID(),
    cookies: {},
    ...overrides,
  };
}

let n = 0;
export function body(overrides: Record<string, unknown> = {}) {
  n++;
  return {
    variant: "b",
    zip: "90210",
    insured: "yes",
    firstName: "Sam",
    lastName: "Lee",
    email: `sam${n}-${Date.now()}@example.com`,
    phone: `(212) 555-${String(1000 + (n % 9000)).padStart(4, "0")}`,
    consentVersion: CURRENT_CONSENT_VERSION,
    pageUrl: "https://quotelane.test/quote",
    ...overrides,
  };
}

// ---------- Fake partner ----------

export interface Received {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

export type Behaviour = (attempt: number) => { status?: number; delayMs?: number; hangUp?: boolean };

export async function fakePartner(behaviour: Behaviour) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
      const b = behaviour(received.length);
      const respond = () => {
        if (b.hangUp) return req.socket.destroy();
        res.writeHead(b.status ?? 200, { "content-type": "application/json" });
        res.end('{"accepted":true}');
      };
      if (b.delayMs) setTimeout(respond, b.delayMs);
      else respond();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/leads`,
    received,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
