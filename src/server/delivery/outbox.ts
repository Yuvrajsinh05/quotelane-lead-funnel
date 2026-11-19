import { and, eq, lt, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import { consents, deliveryAttempts, leads, partnerDeliveries, type PartnerDelivery } from "../db/schema";
import { log } from "../logger";
import { sendToPartner, type SendResult } from "./partner-client";
import { buildPartnerPayload } from "./payload";

/** "Retry once": attempt 1 + one retry. Enforced in the claim SQL, not only in app code. */
export const MAX_ATTEMPTS = 2;
/** Longer than timeout + overhead so a live worker never loses its lease mid-request. */
export const LEASE_SECONDS = 30;
export const RETRY_DELAY_MS = 1000;

export interface DeliveryDeps {
  db: Db;
  config: Pick<AppConfig, "PARTNER_WEBHOOK_URL" | "PARTNER_WEBHOOK_SECRET" | "PARTNER_TIMEOUT_MS" | "PARTNER_SOURCE_IDS">;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

export type DeliveryOutcome = "delivered" | "failed" | "not_claimed" | "unconfigured";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Atomic compare-and-set claim. At most ONE worker (the after() hook, a cron sweep, a
 * second instance) can get a row back, which is what guarantees we never send the same
 * lead twice from our side. Claimable when:
 *  - pending/retry_wait and due, or
 *  - "sending" but the lease expired (the worker died mid-flight), and
 *  - attempts < MAX_ATTEMPTS.
 */
async function claim(db: Db, leadId: string): Promise<PartnerDelivery | null> {
  const [row] = await db
    .update(partnerDeliveries)
    .set({
      status: "sending",
      attempts: sql`${partnerDeliveries.attempts} + 1`,
      leaseUntil: sql`now() + make_interval(secs => ${LEASE_SECONDS})`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(partnerDeliveries.leadId, leadId),
        lt(partnerDeliveries.attempts, MAX_ATTEMPTS),
        sql`(
          (${partnerDeliveries.status} in ('pending','retry_wait') and ${partnerDeliveries.nextAttemptAt} <= now())
          or (${partnerDeliveries.status} = 'sending' and ${partnerDeliveries.leaseUntil} < now())
        )`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Deliver one lead: claim → send → record, with at most one retry.
 * Safe to call concurrently from anywhere; losers of the claim just return "not_claimed".
 */
export async function deliverLead(deps: DeliveryDeps, leadId: string): Promise<DeliveryOutcome> {
  const { db, config } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const url = config.PARTNER_WEBHOOK_URL;
  if (!url) return "unconfigured";

  for (;;) {
    const claimed = await claim(db, leadId);
    if (!claimed) return "not_claimed";
    const attemptNo = claimed.attempts;

    const [row] = await db
      .select({ lead: leads, consent: consents })
      .from(leads)
      .innerJoin(consents, eq(consents.leadId, leads.id))
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!row) {
      await finish(db, leadId, attemptNo, { status: "failed", lastError: "lead_missing" });
      return "failed";
    }

    const sourceId = config.PARTNER_SOURCE_IDS[row.lead.routingProfile] ?? config.PARTNER_SOURCE_IDS.default ?? "default";
    const body = JSON.stringify(buildPartnerPayload(row.lead, row.consent, sourceId));
    const startedAt = new Date();
    const result = await sendToPartner({
      url,
      body,
      idempotencyKey: row.lead.publicId,
      timeoutMs: config.PARTNER_TIMEOUT_MS,
      signingSecret: config.PARTNER_WEBHOOK_SECRET,
      fetchImpl: deps.fetchImpl,
    });

    await recordAttempt(db, leadId, attemptNo, startedAt, result);
    const logFields = {
      leadId,
      attempt: attemptNo,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      errorClass: result.errorClass,
    };

    if (result.ok) {
      await finish(db, leadId, attemptNo, {
        status: "delivered",
        deliveredAt: sql`now()`,
        lastHttpStatus: result.httpStatus,
        lastError: null,
      });
      log.info("delivery.delivered", logFields);
      return "delivered";
    }

    if (result.retryable && attemptNo < MAX_ATTEMPTS) {
      const delay = deps.retryDelayMs ?? RETRY_DELAY_MS;
      await finish(db, leadId, attemptNo, {
        status: "retry_wait",
        nextAttemptAt: sql`now() + make_interval(secs => ${delay / 1000})`,
        lastHttpStatus: result.httpStatus,
        lastError: result.errorClass,
      });
      log.warn("delivery.retry_scheduled", { ...logFields, retryable: true });
      await sleep(delay);
      continue;
    }

    await finish(db, leadId, attemptNo, {
      status: "failed",
      lastHttpStatus: result.httpStatus,
      lastError: result.errorClass,
    });
    log.error("delivery.failed", { ...logFields, retryable: result.retryable });
    return "failed";
  }
}

/**
 * Fenced state transition: only applies if we still own the row (status 'sending' AND
 * the attempt counter is the one we claimed). A worker that stalled past its lease and
 * was superseded cannot overwrite the newer worker's result.
 */
async function finish(
  db: Db,
  leadId: string,
  attemptNo: number,
  set: PgUpdateSetSource<typeof partnerDeliveries>,
): Promise<void> {
  await db
    .update(partnerDeliveries)
    .set({ ...set, leaseUntil: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(partnerDeliveries.leadId, leadId),
        eq(partnerDeliveries.status, "sending"),
        eq(partnerDeliveries.attempts, attemptNo),
      ),
    );
}

async function recordAttempt(db: Db, leadId: string, attemptNo: number, startedAt: Date, r: SendResult) {
  await db.insert(deliveryAttempts).values({
    leadId,
    attemptNo,
    startedAt,
    durationMs: r.durationMs,
    httpStatus: r.httpStatus,
    outcome: r.ok ? "success" : r.retryable ? "retryable_error" : "permanent_error",
    errorClass: r.errorClass,
  });
}

/**
 * Recovery sweep (cron). Picks up deliveries the after() hook never finished
 * (instance killed, deploy mid-flight) and closes out rows that died on their final attempt.
 */
export async function sweepDeliveries(deps: DeliveryDeps, limit = 25): Promise<{ processed: number; exhausted: number }> {
  const { db } = deps;

  const exhausted = await db
    .update(partnerDeliveries)
    .set({ status: "failed", lastError: "lease_expired_on_final_attempt", leaseUntil: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(partnerDeliveries.status, "sending"),
        lt(partnerDeliveries.leaseUntil, sql`now()`),
        sql`${partnerDeliveries.attempts} >= ${MAX_ATTEMPTS}`,
      ),
    )
    .returning({ leadId: partnerDeliveries.leadId });

  const due = await db
    .select({ leadId: partnerDeliveries.leadId })
    .from(partnerDeliveries)
    .where(
      and(
        lt(partnerDeliveries.attempts, MAX_ATTEMPTS),
        sql`(
          (${partnerDeliveries.status} in ('pending','retry_wait') and ${partnerDeliveries.nextAttemptAt} <= now())
          or (${partnerDeliveries.status} = 'sending' and ${partnerDeliveries.leaseUntil} < now())
        )`,
      ),
    )
    .orderBy(partnerDeliveries.nextAttemptAt)
    .limit(limit);

  let processed = 0;
  for (const { leadId } of due) {
    const outcome = await deliverLead(deps, leadId);
    if (outcome !== "not_claimed") processed++;
  }
  return { processed, exhausted: exhausted.length };
}
