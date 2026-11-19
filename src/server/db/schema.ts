import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type FieldProvenance = Record<string, { source: "prefill" | "typed"; modified?: boolean }>;

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** ULID shown to the visitor / used in URLs. Never the internal UUID. */
    publicId: text("public_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** HMAC of the normalized submission; detects an idempotency key reused with a different body. */
    requestHash: text("request_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    brand: text("brand").notNull(),
    variant: text("variant").notNull(),
    variantSource: text("variant_source").notNull(),

    zip: text("zip").notNull(),
    vehicleYear: smallint("vehicle_year"),
    vehicleMake: text("vehicle_make"),
    insured: boolean("insured").notNull(),
    ageRange: text("age_range"),

    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    phoneE164: text("phone_e164").notNull(),

    fieldProvenance: jsonb("field_provenance").$type<FieldProvenance>().notNull(),

    qlClickId: text("ql_click_id"),
    affClickId: text("aff_click_id"),
    affId: text("aff_id"),
    channel: text("channel"),
    channelRaw: text("channel_raw"),
    subIds: jsonb("sub_ids").$type<Record<string, string>>(),
    trackingSource: text("tracking_source").notNull(),
    landedAt: timestamp("landed_at", { withTimezone: true }),

    routingProfile: text("routing_profile").notNull(),
    routingFallback: boolean("routing_fallback").notNull().default(false),
    isTest: boolean("is_test").notNull().default(false),

    visitorId: text("visitor_id"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    uniqueIndex("leads_public_id_uq").on(t.publicId),
    uniqueIndex("leads_idempotency_key_uq").on(t.idempotencyKey),
    // Dedupe lookups: "same email/phone within 24h" is an index range scan on these.
    index("leads_email_created_idx").on(t.emailNormalized, t.createdAt.desc()),
    index("leads_phone_created_idx").on(t.phoneE164, t.createdAt.desc()),
    index("leads_reporting_idx").on(t.createdAt.desc(), t.brand, t.channel, t.variant),
    check("leads_variant_ck", sql`${t.variant} in ('a','b')`),
  ],
);

/** Immutable consent evidence. One per lead. Never updated. */
export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id")
    .notNull()
    .unique()
    .references(() => leads.id, { onDelete: "cascade" }),
  consentVersion: text("consent_version").notNull(),
  consentText: text("consent_text").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  pageUrl: text("page_url").notNull(),
});

export const DELIVERY_STATUSES = [
  "pending",
  "sending",
  "retry_wait",
  "delivered",
  "failed",
  "skipped_unconfigured",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Transactional outbox: one row per lead, written in the same TX as the lead. */
export const partnerDeliveries = pgTable(
  "partner_deliveries",
  {
    leadId: uuid("lead_id")
      .primaryKey()
      .references(() => leads.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryStatus>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastHttpStatus: integer("last_http_status"),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("partner_deliveries_sweep_idx").on(t.status, t.nextAttemptAt),
    check(
      "partner_deliveries_status_ck",
      sql`${t.status} in ('pending','sending','retry_wait','delivered','failed','skipped_unconfigured')`,
    ),
  ],
);

/** Append-only audit of every HTTP attempt to the partner. */
export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    httpStatus: integer("http_status"),
    outcome: text("outcome").notNull(),
    errorClass: text("error_class"),
  },
  (t) => [index("delivery_attempts_lead_idx").on(t.leadId)],
);

/** Fixed-window counters. Key = rule + HMAC(ip): no raw IPs stored here. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type PartnerDelivery = typeof partnerDeliveries.$inferSelect;
