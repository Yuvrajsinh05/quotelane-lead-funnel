import { cleanParam } from "./sanitize";

export const CHANNELS = ["email", "sms", "social"] as const;
export type KnownChannel = (typeof CHANNELS)[number];
export type Channel = KnownChannel | "unknown";

export const SUB_ID_KEYS = ["sub1", "sub2", "sub3", "sub4", "sub5"] as const;
export type SubIdKey = (typeof SUB_ID_KEYS)[number];

/**
 * Attribution context for one tracked arrival. Stored (server-side readable) in a
 * first-party cookie and attached to the lead at submit time.
 */
export interface Tracking {
  /** The AFFILIATE's click id, exactly as they sent it. Never confused with ours. */
  affClickId?: string;
  affId?: string;
  channel?: Channel;
  /** The original channel string when it wasn't one we recognise (e.g. "push", "tiktok"). */
  channelRaw?: string;
  subIds?: Partial<Record<SubIdKey, string>>;
  /** OUR click id, minted per tracked arrival, brand-prefixed (e.g. ql_01J…). */
  qlClickId?: string;
  /** ISO time of the arrival that produced this context. */
  landedAt?: string;
}

/** Query keys consumed by tracking (stripped from the address bar after capture). */
export const TRACKING_PARAM_NAMES: readonly string[] = ["click_id", "clickid", "aff_id", "affid", "channel", ...SUB_ID_KEYS];

const ID_RE = /^[A-Za-z0-9._~-]{1,128}$/;
const AFF_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_RAW_RE = /^[a-z0-9_-]{1,32}$/;

const CHANNEL_ALIASES: Record<string, KnownChannel> = {
  email: "email",
  "e-mail": "email",
  mail: "email",
  sms: "sms",
  text: "sms",
  mms: "sms",
  social: "social",
};

function pick(params: URLSearchParams, keys: string[], re: RegExp): string | undefined {
  for (const k of keys) {
    const v = cleanParam(params.get(k));
    if (v && re.test(v)) return v;
  }
  return undefined;
}

export function parseChannel(raw: string | null): Pick<Tracking, "channel" | "channelRaw"> {
  const v = cleanParam(raw)?.toLowerCase();
  if (!v) return {};
  const known = CHANNEL_ALIASES[v];
  if (known) return { channel: known };
  // Unrecognised but well-formed: keep it so reporting can still see it.
  if (CHANNEL_RAW_RE.test(v)) return { channel: "unknown", channelRaw: v };
  return {};
}

/** Extract valid tracking values from a URL. Missing / junk / macro values are simply absent. */
export function parseTracking(params: URLSearchParams): Tracking {
  const out: Tracking = {};
  const affClickId = pick(params, ["click_id", "clickid"], ID_RE);
  if (affClickId) out.affClickId = affClickId;
  const affId = pick(params, ["aff_id", "affid"], AFF_ID_RE);
  if (affId) out.affId = affId;
  Object.assign(out, parseChannel(params.get("channel")));
  const subIds: Partial<Record<SubIdKey, string>> = {};
  for (const k of SUB_ID_KEYS) {
    const v = pick(params, [k], ID_RE);
    if (v) subIds[k] = v;
  }
  if (Object.keys(subIds).length) out.subIds = subIds;
  return out;
}

export const hasTrackingValues = (t: Tracking): boolean =>
  Boolean(t.affClickId || t.affId || t.channel || (t.subIds && Object.keys(t.subIds).length));

/**
 * Attribution policy: LAST CLICK WINS.
 *  - A new valid affiliate click id means a new click → the incoming context fully
 *    replaces the old one (we must not glue affiliate B's click onto affiliate A's aff_id).
 *  - No new click id → keep the existing context and only fill keys it lacks
 *    (e.g. a refresh with `?channel=email` added by a redirector).
 *  Returns `isNewClick` so the caller can mint a fresh qlClickId.
 */
export function mergeTracking(existing: Tracking | null, incoming: Tracking): { tracking: Tracking; isNewClick: boolean } {
  if (!existing) return { tracking: incoming, isNewClick: hasTrackingValues(incoming) };
  if (incoming.affClickId && incoming.affClickId !== existing.affClickId) {
    return { tracking: incoming, isNewClick: true };
  }
  const merged: Tracking = { ...incoming, ...existing };
  if (incoming.subIds || existing.subIds) merged.subIds = { ...incoming.subIds, ...existing.subIds };
  return { tracking: merged, isNewClick: false };
}

/**
 * Re-validate tracking read back from a cookie or a request body. The browser can
 * edit either, so they go through the same validators as the URL did.
 */
export function revalidateTracking(input: unknown): Tracking {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const params = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    const s = str(v);
    if (s) params.set(k, s);
  };
  set("click_id", src.affClickId);
  set("aff_id", src.affId);
  set("channel", src.channel === "unknown" ? src.channelRaw : src.channel);
  if (src.subIds && typeof src.subIds === "object") {
    for (const k of SUB_ID_KEYS) set(k, (src.subIds as Record<string, unknown>)[k]);
  }
  const out = parseTracking(params);
  const ql = str(src.qlClickId);
  if (ql && /^[a-z]{1,8}_[0-9A-HJKMNP-TV-Z]{26}$/.test(ql)) out.qlClickId = ql;
  const landed = str(src.landedAt);
  if (landed && !Number.isNaN(Date.parse(landed))) out.landedAt = new Date(landed).toISOString();
  return out;
}
