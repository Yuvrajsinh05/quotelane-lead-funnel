import { after, type NextRequest } from "next/server";
import { COOKIE } from "@/domain/cookies";
import { getConfig, getSplitConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { deliverLead } from "@/server/delivery/outbox";
import { clientIp, isAllowedOrigin, json } from "@/server/http";
import { IDEMPOTENCY_KEY_RE, submitLead } from "@/server/leads/lead.service";
import { log } from "@/server/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Headroom for after(): 2 attempts x timeout + backoff, well inside this. */
export const maxDuration = 30;

const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-vercel-id") ?? crypto.randomUUID();

  if (!isAllowedOrigin(req.headers, req.url)) {
    return json({ error: "forbidden" }, 403);
  }
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "unsupported_media_type" }, 415);
  }
  const idempotencyKey = req.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return json({ error: "missing_idempotency_key", message: "Send an Idempotency-Key header (16-128 url-safe chars)." }, 400);
  }

  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json({ error: "payload_too_large" }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  try {
    const config = getConfig();
    const db = getDb();
    const result = await submitLead(
      {
        db,
        config,
        split: getSplitConfig(),
        requestId,
        ip: clientIp(req.headers),
        userAgent: req.headers.get("user-agent"),
        idempotencyKey,
        cookies: {
          tracking: req.cookies.get(COOKIE.tracking)?.value,
          prepop: req.cookies.get(COOKIE.prepop)?.value,
          variant: req.cookies.get(COOKIE.variant)?.value,
          variantOverride: req.cookies.get(COOKIE.variantOverride)?.value,
          visitorId: req.cookies.get(COOKIE.visitorId)?.value,
        },
      },
      body,
    );

    switch (result.kind) {
      case "created": {
        log.info("lead.created", { requestId, leadId: result.leadId, partnerConfigured: result.deliver });
        // Respond first; deliver after the response is flushed. If this instance dies,
        // the outbox row stays claimable and the cron sweep picks it up.
        if (result.deliver) {
          after(async () => {
            try {
              await deliverLead({ db, config }, result.leadId);
            } catch (err) {
              log.error("delivery.crashed", { leadId: result.leadId, err });
            }
          });
        }
        const res = json({ leadId: result.publicId, status: "created" }, 201);
        res.cookies.delete(COOKIE.prepop); // PII no longer needed in the browser
        return res;
      }
      case "replay": {
        log.info("lead.idempotent_replay", { requestId, leadId: result.leadId });
        const res = json({ leadId: result.publicId, status: "created" }, 200, { "Idempotent-Replayed": "true" });
        res.cookies.delete(COOKIE.prepop);
        return res;
      }
      case "duplicate":
        log.info("lead.duplicate", { requestId });
        return json(
          { error: "duplicate", message: "Looks like we already have your request from the last 24 hours. We'll be in touch soon." },
          409,
        );
      case "idempotency_conflict":
        return json({ error: "idempotency_conflict", message: "This request key was already used with different data." }, 422);
      case "invalid":
        return json({ error: "validation_failed", fieldErrors: result.fieldErrors }, 422);
      case "rate_limited":
        return json(
          { error: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." },
          429,
          { "Retry-After": String(result.retryAfterSeconds) },
        );
    }
  } catch (err) {
    log.error("lead.unhandled", { requestId, err });
    return json({ error: "internal_error", message: "Something went wrong on our side. Please try again." }, 500);
  }
}
