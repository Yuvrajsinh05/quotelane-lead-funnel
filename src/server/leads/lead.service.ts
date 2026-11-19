import { and, eq, gt, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { CONSENT_TEXTS } from "@/domain/consent";
import { toE164 } from "@/domain/fields";
import { fieldErrors, leadSubmissionSchema, type LeadSubmission } from "@/domain/lead-schema";
import { PREPOP_KEYS, type Prepop } from "@/domain/prepop";
import { decodeTrackingCookie } from "@/domain/tracking-cookie";
import type { Tracking } from "@/domain/tracking";
import { resolveVariant, type SplitConfig } from "@/domain/variant";
import type { AppConfig } from "../config";
import { hmacHex, PURPOSE } from "../crypto/seal";
import type { Db } from "../db/client";
import { consents, leads, partnerDeliveries, type FieldProvenance } from "../db/schema";
import { log } from "../logger";
import { unsealPrepop } from "../prepop-cookie";
import { consumeRateLimit } from "../rate-limit";

export interface SubmitContext {
  db: Db;
  config: AppConfig;
  split: SplitConfig;
  requestId: string;
  /** From the platform (x-forwarded-for / x-real-ip), never from the body. */
  ip: string | null;
  /** From the request header, never from the body. */
  userAgent: string | null;
  idempotencyKey: string;
  cookies: {
    tracking?: string;
    prepop?: string;
    variant?: string;
    variantOverride?: string;
    visitorId?: string;
  };
}

export type SubmitResult =
  | { kind: "created"; leadId: string; publicId: string; deliver: boolean }
  | { kind: "replay"; leadId: string; publicId: string }
  | { kind: "idempotency_conflict" }
  | { kind: "duplicate" }
  | { kind: "invalid"; fieldErrors: Record<string, string> }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The whole lead-capture use case. Framework-free (the route handler is a thin
 * adapter), so it is integration-tested directly against Postgres.
 */
export async function submitLead(ctx: SubmitContext, body: unknown): Promise<SubmitResult> {
  const { db, config } = ctx;

  // 1. Rate limit first: cheapest rejection, and counts invalid spam too.
  const ipKey = await hmacHex(`${config.APP_SECRET}:${PURPOSE.ipHash}`, ctx.ip ?? "unknown");
  const rate = await consumeRateLimit(db, ipKey);
  if (!rate.ok) {
    log.warn("lead.rate_limited", { requestId: ctx.requestId, reason: rate.rule });
    return { kind: "rate_limited", retryAfterSeconds: rate.retryAfterSeconds };
  }

  // 2. Validate. The server is the authority; client-side validation is only UX.
  const parsed = leadSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    log.info("lead.invalid", { requestId: ctx.requestId, fields: Object.keys(errors) });
    return { kind: "invalid", fieldErrors: errors };
  }
  const input = parsed.data;

  // 3. Context the browser can't forge: tracking from our cookie, prefill provenance from a sealed cookie.
  // Tracking comes ONLY from our HttpOnly cookie, re-validated on read. The body never carries it.
  const tracking: Tracking = decodeTrackingCookie(ctx.cookies.tracking) ?? {};
  const trackingSource = Object.keys(tracking).length ? "cookie" : "none";
  const prepop = await unsealPrepop(ctx.cookies.prepop, config.APP_SECRET);
  const provenance = computeProvenance(input, prepop?.values ?? {});

  const decision = resolveVariant({
    force: null,
    overrideCookie: ctx.cookies.variantOverride,
    stickyCookie: ctx.cookies.variant,
    isBot: false,
    split: ctx.split,
    visitorId: ctx.cookies.visitorId ?? "",
  });
  // The variant stored is the one the visitor actually rendered. If the server would
  // now pick differently (kill switch flipped mid-funnel, cookie cleared) we record that.
  const variantSource = decision.variant === input.variant ? decision.source : "mismatch";

  const channel = tracking.channel;
  const hasProfile = channel !== undefined && channel !== "unknown" && channel in config.PARTNER_SOURCE_IDS;
  const routingProfile = hasProfile ? channel : "default";
  const routingFallback = channel !== undefined && !hasProfile;
  if (routingFallback) {
    log.warn("lead.routing_fallback", { requestId: ctx.requestId, channel, routingProfile });
  }

  const emailNormalized = input.email.toLowerCase();
  const phoneE164 = toE164(input.phone);
  const requestHash = await hmacHex(`${config.APP_SECRET}:${PURPOSE.requestHash}`, canonical(input));
  const consentText = CONSENT_TEXTS[input.consentVersion];

  // 4. One transaction: serialize on idempotency key + email + phone, then check, then insert.
  try {
    return await db.transaction(async (tx) => {
      // Advisory locks close the check-then-insert race: two concurrent submits with the
      // same email (different idempotency keys) would otherwise both pass the dedupe
      // check. Locks are xact-scoped (auto-released, pooler-safe) and acquired in a
      // sorted order so two transactions can never deadlock on each other.
      const lockKeys = [`idem:${ctx.idempotencyKey}`, `email:${emailNormalized}`, `phone:${phoneE164}`].sort();
      for (const k of lockKeys) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
      }

      const [existing] = await tx
        .select({ id: leads.id, publicId: leads.publicId, requestHash: leads.requestHash })
        .from(leads)
        .where(eq(leads.idempotencyKey, ctx.idempotencyKey))
        .limit(1);
      if (existing) {
        if (existing.requestHash !== requestHash) return { kind: "idempotency_conflict" } as const;
        return { kind: "replay", leadId: existing.id, publicId: existing.publicId } as const;
      }

      const [dup] = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(
          and(
            or(eq(leads.emailNormalized, emailNormalized), eq(leads.phoneE164, phoneE164)),
            gt(leads.createdAt, sql`now() - interval '24 hours'`),
          ),
        )
        .limit(1);
      if (dup) return { kind: "duplicate" } as const;

      const publicId = ulid();
      const [lead] = await tx
        .insert(leads)
        .values({
          publicId,
          idempotencyKey: ctx.idempotencyKey,
          requestHash,
          brand: config.BRAND_ID,
          variant: input.variant,
          variantSource,
          zip: input.zip,
          vehicleYear: input.variant === "a" ? input.vehicleYear : null,
          vehicleMake: input.variant === "a" ? input.vehicleMake : null,
          ageRange: input.variant === "a" ? input.ageRange : null,
          insured: input.insured,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          emailNormalized,
          phoneE164,
          fieldProvenance: provenance,
          qlClickId: tracking.qlClickId ?? null,
          affClickId: tracking.affClickId ?? null,
          affId: tracking.affId ?? null,
          channel: tracking.channel ?? null,
          channelRaw: tracking.channelRaw ?? null,
          subIds: tracking.subIds && Object.keys(tracking.subIds).length ? tracking.subIds : null,
          trackingSource,
          landedAt: tracking.landedAt ? new Date(tracking.landedAt) : null,
          routingProfile,
          routingFallback,
          isTest: variantSource === "forced",
          visitorId: ctx.cookies.visitorId && /^[A-Za-z0-9-]{8,64}$/.test(ctx.cookies.visitorId) ? ctx.cookies.visitorId : null,
          ip: ctx.ip,
          userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        })
        .returning({ id: leads.id });
      const leadId = lead!.id;

      await tx.insert(consents).values({
        leadId,
        consentVersion: input.consentVersion,
        consentText,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 512) ?? null,
        pageUrl: input.pageUrl,
      });

      const deliver = Boolean(config.PARTNER_WEBHOOK_URL);
      await tx.insert(partnerDeliveries).values({ leadId, status: deliver ? "pending" : "skipped_unconfigured" });

      return { kind: "created", leadId, publicId, deliver } as const;
    });
  } catch (err) {
    // Backstop: the UNIQUE(idempotency_key) constraint. Only reachable if the advisory
    // lock was somehow bypassed; resolve it as a replay rather than a 500.
    if (isUniqueViolation(err, "leads_idempotency_key_uq")) {
      const [existing] = await db
        .select({ id: leads.id, publicId: leads.publicId })
        .from(leads)
        .where(eq(leads.idempotencyKey, ctx.idempotencyKey))
        .limit(1);
      if (existing) return { kind: "replay", leadId: existing.id, publicId: existing.publicId };
    }
    throw err;
  }
}

/**
 * Per field: was it prefilled from the affiliate link, and did the visitor change it?
 * Computed from the SEALED cookie, so it's server-authoritative.
 */
export function computeProvenance(input: LeadSubmission, prepop: Prepop): FieldProvenance {
  const submitted: Record<string, unknown> = {
    zip: input.zip,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
    insured: input.insured,
    vehicleYear: input.variant === "a" ? input.vehicleYear : undefined,
    vehicleMake: input.variant === "a" ? input.vehicleMake : undefined,
    ageRange: input.variant === "a" ? input.ageRange : undefined,
  };
  const out: FieldProvenance = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (value === undefined) continue;
    const pre = (PREPOP_KEYS as readonly string[]).includes(key) ? prepop[key as keyof Prepop] : undefined;
    out[key] = pre === undefined ? { source: "typed" } : { source: "prefill", modified: pre !== value };
  }
  return out;
}

/** Stable serialization of the normalized submission (key order independent). */
function canonical(input: LeadSubmission): string {
  return JSON.stringify(Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))));
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: string; constraint_name?: string; constraint?: string };
    if (pg.code === "23505" && (pg.constraint_name ?? pg.constraint) === constraint) return true;
  }
  return false;
}
