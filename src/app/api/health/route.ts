import { sql } from "drizzle-orm";
import { getSplitConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + DB reachability + effective split config (no secrets). */
export async function GET() {
  const split = getSplitConfig();
  try {
    await getDb().execute(sql`select 1`);
    return json({ ok: true, db: "up", splitPercentB: split.percentB, splitConfigValid: split.valid }, 200);
  } catch {
    return json({ ok: false, db: "down" }, 503);
  }
}
