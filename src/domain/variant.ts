export const VARIANTS = ["a", "b"] as const;
export type Variant = (typeof VARIANTS)[number];

export const isVariant = (v: unknown): v is Variant => v === "a" || v === "b";

/**
 * Why a visitor sees the version they see. Stored on every lead so experiment
 * reporting can include only `assigned` + `sticky` and exclude test/bot/kill-switch traffic.
 */
export type VariantSource = "assigned" | "sticky" | "forced" | "bot" | "killswitch";

export interface SplitConfig {
  /** 0..100 share of NEW visitors that get B. */
  percentB: number;
  /** false when the env var was missing/garbage and we fell back to 0. */
  valid: boolean;
}

/**
 * Parse SPLIT_PERCENT_B defensively. Anything that isn't an integer 0..100 falls back
 * to 0 (everyone on the control): a typo in config must never send all traffic to the
 * experimental version.
 */
export function parseSplitPercent(raw: string | undefined | null): SplitConfig {
  if (raw == null || raw.trim() === "") return { percentB: 0, valid: false };
  const v = raw.trim();
  if (!/^\d{1,3}$/.test(v)) return { percentB: 0, valid: false };
  const n = Number(v);
  if (n < 0 || n > 100) return { percentB: 0, valid: false };
  return { percentB: n, valid: true };
}

/**
 * FNV-1a 32-bit → bucket 0..99. Deterministic per visitor id, so:
 *  - the same visitor always lands in the same bucket (even if the variant cookie is lost
 *    but the visitor-id cookie survives), and
 *  - raising percentB only ever moves visitors A→B, never B→A (buckets are fixed).
 */
export function bucketOf(visitorId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < visitorId.length; i++) {
    h ^= visitorId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

export type ForceParam = Variant | "clear" | null;

export function parseForceParam(raw: string | null): ForceParam {
  const v = raw?.trim().toLowerCase();
  if (v === "a" || v === "b" || v === "clear") return v;
  return null;
}

export interface VariantInput {
  /** `?variant=` on this request */
  force: ForceParam;
  /** session-only override cookie from a previous `?variant=` */
  overrideCookie: string | undefined;
  /** long-lived sticky assignment cookie */
  stickyCookie: string | undefined;
  isBot: boolean;
  split: SplitConfig;
  visitorId: string;
}

export interface VariantDecision {
  variant: Variant;
  source: VariantSource;
  /** Cookie mutations the caller must apply. `null` = delete. `undefined` = leave alone. */
  setOverride?: Variant | null;
  setSticky?: Variant;
}

/**
 * The single source of truth for "which form does this visitor see". Pure, so every
 * rule is unit-tested without a browser.
 *
 * Precedence (highest first):
 *  1. ?variant=a|b      → forced, session-only (never touches the sticky cookie)
 *     ?variant=clear    → drop the override, fall through
 *  2. override cookie   → forced (keeps a tester on the same version across steps)
 *  3. search-engine bot → always A, no cookies
 *  4. kill switch       → percentB 0 ⇒ everyone A, 100 ⇒ everyone B (sticky ignored, NOT rewritten)
 *  5. sticky cookie     → whatever they were assigned before (never reshuffled)
 *  6. new visitor       → bucket(visitorId) < percentB ? B : A, then made sticky
 */
export function resolveVariant(input: VariantInput): VariantDecision {
  const { force, overrideCookie, stickyCookie, isBot, split, visitorId } = input;

  if (force === "a" || force === "b") {
    return { variant: force, source: "forced", setOverride: force };
  }
  const clearing = force === "clear";
  if (!clearing && isVariant(overrideCookie)) {
    return { variant: overrideCookie, source: "forced" };
  }
  const base = resolveUnforced({ stickyCookie, isBot, split, visitorId });
  return clearing ? { ...base, setOverride: null } : base;
}

function resolveUnforced(input: Pick<VariantInput, "stickyCookie" | "isBot" | "split" | "visitorId">): VariantDecision {
  const { stickyCookie, isBot, split, visitorId } = input;
  if (isBot) return { variant: "a", source: "bot" };
  if (split.percentB <= 0) return { variant: "a", source: "killswitch" };
  if (split.percentB >= 100) return { variant: "b", source: "killswitch" };
  if (isVariant(stickyCookie)) return { variant: stickyCookie, source: "sticky" };
  const variant: Variant = bucketOf(visitorId) < split.percentB ? "b" : "a";
  return { variant, source: "assigned", setSticky: variant };
}
