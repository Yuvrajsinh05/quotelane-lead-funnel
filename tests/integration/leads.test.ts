import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_CONSENT_TEXT } from "@/domain/consent";
import { encodeTrackingCookie } from "@/domain/tracking-cookie";
import { consents, leads, partnerDeliveries } from "@/server/db/schema";
import { submitLead } from "@/server/leads/lead.service";
import { sealPrepop } from "@/server/prepop-cookie";
import { body, config, ctx, db, holder, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => holder.sql.end());


describe("submitLead — happy path", () => {
  it("stores lead + immutable consent + pending outbox row in one transaction", async () => {
    const tracking = encodeTrackingCookie({
      affClickId: "abc123",
      affId: "42",
      channel: "email",
      qlClickId: "ql_01JCDEFGHJKMNPQRSTVWXYZ012",
      landedAt: new Date().toISOString(),
    });
    const r = await submitLead(
      ctx({ ip: "198.51.100.7", userAgent: "UA/1.0", cookies: { tracking, variant: "b", visitorId: "visitor-123456" } }),
      body({ email: "Sam@Example.com" }),
    );
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;

    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead).toMatchObject({
      publicId: r.publicId,
      variant: "b",
      variantSource: "sticky",
      email: "sam@example.com",
      emailNormalized: "sam@example.com",
      affClickId: "abc123",
      affId: "42",
      channel: "email",
      qlClickId: "ql_01JCDEFGHJKMNPQRSTVWXYZ012",
      trackingSource: "cookie",
      routingProfile: "email",
      routingFallback: false,
      vehicleYear: null,
      ip: "198.51.100.7",
      userAgent: "UA/1.0",
      isTest: false,
    });
    expect(lead!.phoneE164).toMatch(/^\+1212555\d{4}$/);

    const [consent] = await db.select().from(consents).where(eq(consents.leadId, r.leadId));
    expect(consent).toMatchObject({ consentText: CURRENT_CONSENT_TEXT, ip: "198.51.100.7", userAgent: "UA/1.0", pageUrl: "https://quotelane.test/quote" });

    const [delivery] = await db.select().from(partnerDeliveries).where(eq(partnerDeliveries.leadId, r.leadId));
    expect(delivery).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("computes prefill provenance from the SEALED cookie (prefilled, edited, typed)", async () => {
    const prepop = await sealPrepop(
      { nonce: "nonce-12345678", values: { zip: "90210", firstName: "Sam", email: "sam.prefill@example.com", insured: true } },
      config.APP_SECRET,
    );
    const r = await submitLead(
      ctx({ cookies: { prepop } }),
      body({ zip: "90210", firstName: "Samuel", email: "sam.prefill@example.com", insured: true }),
    );
    if (r.kind !== "created") throw new Error(r.kind);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead!.fieldProvenance).toEqual({
      zip: { source: "prefill", modified: false },
      firstName: { source: "prefill", modified: true },
      email: { source: "prefill", modified: false },
      insured: { source: "prefill", modified: false },
      lastName: { source: "typed" },
      phone: { source: "typed" },
    });
  });

  it("a forged prepop cookie is ignored (everything counts as typed)", async () => {
    const r = await submitLead(ctx({ cookies: { prepop: "forged.cookie" } }), body());
    if (r.kind !== "created") throw new Error(r.kind);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(Object.values(lead!.fieldProvenance).every((p) => p.source === "typed")).toBe(true);
  });

  it("junk tracking cookie doesn't break anything", async () => {
    const r = await submitLead(ctx({ cookies: { tracking: "%%%garbage", variant: "zzz", visitorId: "<script>" } }), body());
    expect(r.kind).toBe("created");
  });
});

describe("submitLead — validation", () => {
  it("rejects invalid fields with per-field messages", async () => {
    const r = await submitLead(ctx(), body({ email: "notanemail", phone: "abc", zip: "00000" }));
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(Object.keys(r.fieldErrors).sort()).toEqual(["email", "phone", "zip"]);
  });
  it("variant A requires vehicle + age answers", async () => {
    const r = await submitLead(ctx(), body({ variant: "a" }));
    expect(r.kind).toBe("invalid");
  });
  it("rejects non-object bodies", async () => {
    expect((await submitLead(ctx(), null)).kind).toBe("invalid");
    expect((await submitLead(ctx(), "x")).kind).toBe("invalid");
  });
});

describe("submitLead — idempotency (double-click)", () => {
  it("same key + same body → one lead, replay returns the same id", async () => {
    const c = ctx();
    const b = body();
    const first = await submitLead(c, b);
    const second = await submitLead(c, b);
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("replay");
    if (first.kind === "created" && second.kind === "replay") expect(second.publicId).toBe(first.publicId);
    const [{ count }] = (await db.execute(sql`select count(*)::int as count from leads`)) as unknown as [{ count: number }];
    expect(count).toBe(1);
  });

  it("5 concurrent submits with the same key → exactly one lead", async () => {
    const c = ctx();
    const b = body();
    const results = await Promise.all(Array.from({ length: 5 }, () => submitLead({ ...c }, b)));
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "replay")).toHaveLength(4);
  });

  it("same key reused with a different body → conflict, not a silent replay", async () => {
    const c = ctx();
    await submitLead(c, body({ email: "one@example.com" }));
    const r = await submitLead(c, body({ email: "one@example.com", zip: "10001" }));
    expect(r.kind).toBe("idempotency_conflict");
  });
});

describe("submitLead — 24h duplicate rule", () => {
  it("same email (any case) or same phone within 24h is rejected", async () => {
    await submitLead(ctx(), body({ email: "dupe@example.com", phone: "2125550111" }));
    expect((await submitLead(ctx(), body({ email: "DUPE@example.com", phone: "2125550199" }))).kind).toBe("duplicate");
    expect((await submitLead(ctx(), body({ email: "other@example.com", phone: "+1 (212) 555-0111" }))).kind).toBe("duplicate");
  });

  it("allowed again after 24 hours", async () => {
    await submitLead(ctx(), body({ email: "old@example.com" }));
    await db.execute(sql`update leads set created_at = now() - interval '25 hours'`);
    expect((await submitLead(ctx(), body({ email: "old@example.com" }))).kind).toBe("created");
  });

  it("race: 6 concurrent submits, same email, different keys → exactly one lead", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => submitLead(ctx(), body({ email: "race@example.com", phone: `212555${String(2000 + i)}` }))),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "duplicate")).toHaveLength(5);
  });
});

describe("submitLead — rate limiting", () => {
  it("blocks the 11th request from one IP inside 10 minutes, with Retry-After", async () => {
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await submitLead(ctx({ ip: "192.0.2.50" }), body()));
    expect(results.slice(0, 10).every((r) => r.kind === "created")).toBe(true);
    const last = results[10]!;
    expect(last.kind).toBe("rate_limited");
    if (last.kind === "rate_limited") expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect((await submitLead(ctx({ ip: "192.0.2.51" }), body())).kind).toBe("created");
  });

  it("stores no raw IPs in the rate-limit table", async () => {
    await submitLead(ctx({ ip: "192.0.2.77" }), body());
    const rows = (await db.execute(sql`select key from rate_limits`)) as unknown as { key: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.key.includes("192.0.2.77"))).toBe(true);
  });
});

describe("submitLead — variant, routing, config", () => {
  it("forced-variant leads are flagged as test traffic", async () => {
    const r = await submitLead(ctx({ cookies: { variantOverride: "b" } }), body());
    if (r.kind !== "created") throw new Error(r.kind);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead).toMatchObject({ variantSource: "forced", isTest: true });
  });

  it("records a mismatch when the rendered variant differs from what the server would serve now", async () => {
    const r = await submitLead(ctx({ cookies: { variant: "b" }, split: { percentB: 0, valid: true } }), body({ variant: "b" }));
    if (r.kind !== "created") throw new Error(r.kind);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead).toMatchObject({ variant: "b", variantSource: "mismatch" });
  });

  it("channel=sms with no SMS source id: lead kept, routed via default, flagged for reporting", async () => {
    const tracking = encodeTrackingCookie({ affClickId: "c1", affId: "7", channel: "sms" });
    const r = await submitLead(ctx({ cookies: { tracking } }), body());
    if (r.kind !== "created") throw new Error(r.kind);
    const [lead] = await db.select().from(leads).where(eq(leads.id, r.leadId));
    expect(lead).toMatchObject({ channel: "sms", routingProfile: "default", routingFallback: true });
  });

  it("no partner URL configured → lead saved, delivery marked skipped_unconfigured", async () => {
    const r = await submitLead(ctx({ config: { ...config, PARTNER_WEBHOOK_URL: undefined } }), body());
    if (r.kind !== "created") throw new Error(r.kind);
    expect(r.deliver).toBe(false);
    const [d] = await db.select().from(partnerDeliveries).where(eq(partnerDeliveries.leadId, r.leadId));
    expect(d!.status).toBe("skipped_unconfigured");
  });
});
