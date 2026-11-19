import { z } from "zod";
import { parseSplitPercent, type SplitConfig } from "@/domain/variant";

/**
 * Env parsing. Lazy + memoized (not at import time) so `next build` doesn't need
 * runtime secrets, but the first request fails fast with a clear message if
 * required config is missing.
 */
const DEV_SECRET = "dev-only-secret-change-me-dev-only-secret-change-me";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  APP_SECRET: z.string().min(32, "APP_SECRET must be at least 32 characters"),
  PARTNER_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined))
    .refine((v) => v === undefined || /^https?:\/\//.test(v), "PARTNER_WEBHOOK_URL must be an http(s) URL"),
  PARTNER_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined)),
  PARTNER_TIMEOUT_MS: z.coerce.number().int().min(500).max(20_000).default(5000),
  PARTNER_SOURCE_IDS: z
    .string()
    .optional()
    .transform((raw, ctx): Record<string, string> => {
      if (!raw || !raw.trim()) return { default: "QL-WEB-001" };
      try {
        const parsed = z.record(z.string(), z.string().min(1)).parse(JSON.parse(raw));
        if (!parsed.default) parsed.default = "QL-WEB-001";
        return parsed;
      } catch {
        ctx.addIssue({ code: "custom", message: "PARTNER_SOURCE_IDS must be a JSON object of strings" });
        return z.NEVER;
      }
    }),
  BRAND_ID: z
    .string()
    .regex(/^[a-z0-9-]{2,32}$/)
    .default("quotelane"),
  BRAND_CLICK_PREFIX: z
    .string()
    .regex(/^[a-z]{1,8}$/)
    .default("ql"),
  CRON_SECRET: z.string().optional(),
});

export type AppConfig = z.output<typeof schema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const env: Record<string, string | undefined> = { ...process.env };
  if (!env.APP_SECRET && process.env.NODE_ENV !== "production") env.APP_SECRET = DEV_SECRET;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Read per request (not cached) so the value in the running instance's env is always used. */
export function getSplitConfig(): SplitConfig {
  return parseSplitPercent(process.env.SPLIT_PERCENT_B);
}

/** Proxy-safe accessor: never throws; null if there is no usable secret. */
export function getAppSecretOrNull(): string | null {
  const s = process.env.APP_SECRET ?? (process.env.NODE_ENV !== "production" ? DEV_SECRET : undefined);
  return s && s.length >= 32 ? s : null;
}

export function getBrandClickPrefix(): string {
  const p = process.env.BRAND_CLICK_PREFIX;
  return p && /^[a-z]{1,8}$/.test(p) ? p : "ql";
}

/** Test hook. */
export function resetConfigCache(): void {
  cached = undefined;
}
