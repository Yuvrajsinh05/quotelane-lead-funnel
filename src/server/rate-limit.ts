import { sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { rateLimits } from "./db/schema";

export interface RateRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

/**
 * Two windows: a short one stops bursts (scripted resubmits), a long one caps slow
 * drips. Generous enough that a real person fixing validation errors never hits it
 * (the client validates first, so most people send exactly one request).
 */
export const LEAD_RATE_RULES: readonly RateRule[] = [
  { name: "leads:10m", limit: 10, windowSeconds: 600 },
  { name: "leads:1h", limit: 30, windowSeconds: 3600 },
];

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number; rule: string };

/**
 * Fixed-window counter in Postgres: one atomic UPSERT per rule. Works across every
 * serverless instance (in-memory counters don't: each instance has its own memory).
 * Trade-off: fixed windows allow up to 2x the limit across a boundary. Acceptable for
 * abuse-dampening; a sliding window in Redis is the at-scale answer (see README).
 */
export async function consumeRateLimit(
  db: Db,
  subjectKey: string,
  rules: readonly RateRule[] = LEAD_RATE_RULES,
  now: Date = new Date(),
): Promise<RateResult> {
  let worst: RateResult = { ok: true };
  for (const rule of rules) {
    const windowMs = rule.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const [row] = await db
      .insert(rateLimits)
      .values({ key: `${rule.name}:${subjectKey}`, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });
    if ((row?.count ?? 0) > rule.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
      if (worst.ok || retryAfterSeconds > worst.retryAfterSeconds) worst = { ok: false, retryAfterSeconds, rule: rule.name };
    }
  }
  return worst;
}

export async function purgeExpiredRateLimits(db: Db, olderThanSeconds = 86_400): Promise<number> {
  const res = await db
    .delete(rateLimits)
    .where(sql`${rateLimits.windowStart} < now() - make_interval(secs => ${olderThanSeconds})`)
    .returning({ key: rateLimits.key });
  return res.length;
}
