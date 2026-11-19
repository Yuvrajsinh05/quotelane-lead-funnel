/** Cookie names in one place. Short, opaque, first-party. */
export const COOKIE = {
  /** random visitor id (1 year) — the hashing input for bucketing */
  visitorId: "ql_vid",
  /** sticky A/B assignment (1 year) */
  variant: "ql_v",
  /** session-only forced-variant override (testing) */
  variantOverride: "ql_vo",
  /** sanitized tracking context (30 days, no PII) */
  tracking: "ql_trk",
  /** AES-GCM sealed prepop data (PII, 2 hours, HttpOnly) */
  prepop: "ql_pp",
} as const;

export const MAX_AGE = {
  visitorId: 60 * 60 * 24 * 365,
  variant: 60 * 60 * 24 * 365,
  tracking: 60 * 60 * 24 * 30,
  prepop: 60 * 60 * 2,
} as const;
