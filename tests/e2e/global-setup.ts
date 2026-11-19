import { config } from "dotenv";
import postgres from "postgres";

/** Local runs share one IP, so clear rate-limit windows before the suite. */
export default async function globalSetup() {
  if (process.env.E2E_BASE_URL) return;
  config({ quiet: true });
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  await sql`truncate table rate_limits`;
  await sql.end();
}
