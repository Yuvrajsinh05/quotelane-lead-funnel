import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { sweepDeliveries } from "@/server/delivery/outbox";
import { json } from "@/server/http";
import { log } from "@/server/logger";
import { purgeExpiredRateLimits } from "@/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: NextRequest) {
  const config = getConfig();
  if (!config.CRON_SECRET || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${config.CRON_SECRET}`)) {
    return json({ error: "unauthorized" }, 401);
  }
  const db = getDb();
  const result = await sweepDeliveries({ db, config });
  const purged = await purgeExpiredRateLimits(db);
  log.info("cron.deliveries", { processed: result.processed, exhausted: result.exhausted, purged });
  return json({ ...result, rateLimitRowsPurged: purged }, 200);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
