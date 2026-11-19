import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeTrackingCookie } from "@/domain/tracking-cookie";
import { deliveryAttempts, partnerDeliveries } from "@/server/db/schema";
import { deliverLead, sweepDeliveries, type DeliveryDeps } from "@/server/delivery/outbox";
import { submitLead } from "@/server/leads/lead.service";
import { body, config, ctx, db, fakePartner, holder, resetDb, type Behaviour } from "./helpers";

beforeEach(resetDb);
afterAll(() => holder.sql.end());

let partner: Awaited<ReturnType<typeof fakePartner>> | null = null;
afterEach(async () => {
  await partner?.close();
  partner = null;
});

async function setup(behaviour: Behaviour, timeoutMs = 400) {
  partner = await fakePartner(behaviour);
  const deps: DeliveryDeps = {
    db,
    config: { ...config, PARTNER_WEBHOOK_URL: partner.url, PARTNER_TIMEOUT_MS: timeoutMs },
    retryDelayMs: 20,
  };
  const tracking = encodeTrackingCookie({ affClickId: "aff-click-9", affId: "42", channel: "email", qlClickId: "ql_01JCDEFGHJKMNPQRSTVWXYZ012" });
  const r = await submitLead(ctx({ config: deps.config as typeof config, cookies: { tracking } }), body());
  if (r.kind !== "created") throw new Error(r.kind);
  return { deps, leadId: r.leadId, publicId: r.publicId, partner };
}

const deliveryRow = async (leadId: string) =>
  (await db.select().from(partnerDeliveries).where(eq(partnerDeliveries.leadId, leadId)))[0]!;
const attemptRows = (leadId: string) => db.select().from(deliveryAttempts).where(eq(deliveryAttempts.leadId, leadId));

describe("partner delivery", () => {
  it("delivers once with click_id, aff_id, idempotency key and a valid signature", async () => {
    const { deps, leadId, publicId, partner } = await setup(() => ({ status: 200 }));
    expect(await deliverLead(deps, leadId)).toBe("delivered");

    expect(partner.received).toHaveLength(1);
    const req = partner.received[0]!;
    expect(req.body).toMatchObject({ lead_id: publicId, click_id: "aff-click-9", aff_id: "42", sub_id: "ql_01JCDEFGHJKMNPQRSTVWXYZ012", source_id: "QL-EM-001" });
    expect(req.headers["idempotency-key"]).toBe(publicId);
    const ts = req.headers["x-quotelane-timestamp"] as string;
    const expected = createHmac("sha256", "partner-signing-secret").update(`${ts}.${JSON.stringify(req.body)}`).digest("hex");
    expect(req.headers["x-quotelane-signature"]).toBe(`v1=${expected}`);

    expect(await deliveryRow(leadId)).toMatchObject({ status: "delivered", attempts: 1, lastHttpStatus: 200 });
    expect(await attemptRows(leadId)).toHaveLength(1);
  });

  it("retries once after a 5xx, then succeeds", async () => {
    const { deps, leadId, partner } = await setup((n) => ({ status: n === 1 ? 503 : 200 }));
    expect(await deliverLead(deps, leadId)).toBe("delivered");
    expect(partner.received).toHaveLength(2);
    expect(await deliveryRow(leadId)).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("retries once after a timeout (slow partner), then gives up — never a third attempt", async () => {
    const { deps, leadId, partner } = await setup(() => ({ delayMs: 1500 }), 300);
    expect(await deliverLead(deps, leadId)).toBe("failed");
    expect(partner.received).toHaveLength(2);
    const row = await deliveryRow(leadId);
    expect(row).toMatchObject({ status: "failed", attempts: 2, lastError: "timeout" });
    expect((await attemptRows(leadId)).map((a) => a.errorClass)).toEqual(["timeout", "timeout"]);
    // Calling again (cron, a stray retry) cannot send a third time.
    expect(await deliverLead(deps, leadId)).toBe("not_claimed");
    expect(partner.received).toHaveLength(2);
  });

  it("handles a partner that drops the connection", async () => {
    const { deps, leadId } = await setup(() => ({ hangUp: true }));
    expect(await deliverLead(deps, leadId)).toBe("failed");
    expect((await attemptRows(leadId)).map((a) => a.errorClass)).toEqual(["network", "network"]);
  });

  it("does NOT retry a 4xx (the payload is the problem, retrying can't help)", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 422 }));
    expect(await deliverLead(deps, leadId)).toBe("failed");
    expect(partner.received).toHaveLength(1);
    expect(await deliveryRow(leadId)).toMatchObject({ status: "failed", attempts: 1, lastHttpStatus: 422 });
  });

  it("5 concurrent workers on one lead → the partner receives it exactly once", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 200, delayMs: 100 }));
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => deliverLead(deps, leadId)));
    expect(outcomes.filter((o) => o === "delivered")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "not_claimed")).toHaveLength(4);
    expect(partner.received).toHaveLength(1);
  });

  it("an already-delivered lead is never re-sent", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 200 }));
    await deliverLead(deps, leadId);
    expect(await deliverLead(deps, leadId)).toBe("not_claimed");
    expect(partner.received).toHaveLength(1);
  });
});

describe("cron sweep (recovery)", () => {
  it("delivers leads whose after() hook never ran", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 200 }));
    const result = await sweepDeliveries(deps);
    expect(result.processed).toBe(1);
    expect(partner.received).toHaveLength(1);
    expect((await deliveryRow(leadId)).status).toBe("delivered");
  });

  it("re-claims a lead whose worker died mid-flight (expired lease), using the retry budget", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 200 }));
    await db.execute(sql`update partner_deliveries set status='sending', attempts=1, lease_until=now() - interval '1 minute'`);
    await sweepDeliveries(deps);
    expect(partner.received).toHaveLength(1);
    expect(await deliveryRow(leadId)).toMatchObject({ status: "delivered", attempts: 2 });
  });

  it("closes out a lead that died on its final attempt instead of sending a third time", async () => {
    const { deps, leadId, partner } = await setup(() => ({ status: 200 }));
    await db.execute(sql`update partner_deliveries set status='sending', attempts=2, lease_until=now() - interval '1 minute'`);
    const result = await sweepDeliveries(deps);
    expect(result).toEqual({ processed: 0, exhausted: 1 });
    expect(partner.received).toHaveLength(0);
    expect(await deliveryRow(leadId)).toMatchObject({ status: "failed", lastError: "lease_expired_on_final_attempt" });
  });

  it("leaves an in-flight lead with a live lease alone", async () => {
    const { deps, partner } = await setup(() => ({ status: 200 }));
    await db.execute(sql`update partner_deliveries set status='sending', attempts=1, lease_until=now() + interval '1 minute'`);
    expect((await sweepDeliveries(deps)).processed).toBe(0);
    expect(partner.received).toHaveLength(0);
  });
});
