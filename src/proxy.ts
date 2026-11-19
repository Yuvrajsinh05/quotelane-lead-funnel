import { NextResponse, type NextRequest } from "next/server";
import { ulid } from "ulid";
import { isSearchBot } from "@/domain/bots";
import { COOKIE, MAX_AGE } from "@/domain/cookies";
import { parsePrepop, PREPOP_PARAM_NAMES } from "@/domain/prepop";
import { mergeTracking, parseTracking, TRACKING_PARAM_NAMES } from "@/domain/tracking";
import { decodeTrackingCookie, encodeTrackingCookie } from "@/domain/tracking-cookie";
import { parseForceParam, resolveVariant } from "@/domain/variant";
import { getAppSecretOrNull, getBrandClickPrefix, getSplitConfig } from "@/server/config";
import { log } from "@/server/logger";
import { sealPrepop } from "@/server/prepop-cookie";

/**
 * Request pipeline for the funnel pages (see docs/ARCHITECTURE.md §3):
 *   bot detect → visitor id → tracking capture → prepop capture (sealed) →
 *   variant resolve → strip consumed params via redirect → rewrite /quote to its variant.
 *
 * Everything that decides anything lives in src/domain (pure, unit-tested); this file
 * only translates between HTTP and those functions.
 */

const CONSUMED_PARAMS = new Set([...TRACKING_PARAM_NAMES, ...PREPOP_PARAM_NAMES, "variant"]);

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const { pathname, searchParams } = req.nextUrl;

  // Direct hits on the internal variant routes would bypass the split. Send them to /quote.
  if (pathname.startsWith("/quote/v")) {
    return NextResponse.redirect(new URL("/quote", req.url), 307);
  }

  const isPrefetch =
    req.headers.get("next-router-prefetch") === "1" ||
    req.headers.get("purpose") === "prefetch" ||
    (req.headers.get("sec-purpose") ?? "").includes("prefetch");
  const userAgent = req.headers.get("user-agent");
  const isBot = isSearchBot(userAgent);
  // Prefetches and bots must never create identity, assignments, or attribution.
  const writable = !isPrefetch && !isBot;
  const secure = req.nextUrl.protocol === "https:";
  const cookieOpts = { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
  const pending: Array<(res: NextResponse) => void> = [];

  // ---- visitor id ----
  let visitorId = req.cookies.get(COOKIE.visitorId)?.value;
  if (!visitorId || !/^[A-Za-z0-9-]{8,64}$/.test(visitorId)) {
    visitorId = crypto.randomUUID();
    if (writable) {
      const id = visitorId;
      pending.push((res) => res.cookies.set(COOKIE.visitorId, id, { ...cookieOpts, maxAge: MAX_AGE.visitorId }));
    }
  }

  const hasConsumable = [...searchParams.keys()].some((k) => CONSUMED_PARAMS.has(k.toLowerCase()));
  const params = lowerCaseKeys(searchParams);

  // ---- tracking (last click wins) ----
  const existingTracking = decodeTrackingCookie(req.cookies.get(COOKIE.tracking)?.value);
  if (writable) {
    const incoming = parseTracking(params);
    const { tracking, isNewClick } = mergeTracking(existingTracking, incoming);
    if (isNewClick || !existingTracking) {
      tracking.qlClickId = `${getBrandClickPrefix()}_${ulid()}`;
      tracking.landedAt = new Date().toISOString();
    }
    if (isNewClick || !existingTracking || hasConsumable) {
      const value = encodeTrackingCookie(tracking);
      pending.push((res) => res.cookies.set(COOKIE.tracking, value, { ...cookieOpts, maxAge: MAX_AGE.tracking }));
    }

    // ---- prepop ----
    if (hasConsumable) {
      const prepop = parsePrepop(params);
      const secret = getAppSecretOrNull();
      if (Object.keys(prepop).length && secret) {
        const sealed = await sealPrepop({ nonce: ulid(), values: prepop }, secret);
        pending.push((res) =>
          res.cookies.set(COOKIE.prepop, sealed, { ...cookieOpts, maxAge: MAX_AGE.prepop }),
        );
      } else if (isNewClick) {
        // A new click with no prefill must not inherit the previous click's personal data.
        pending.push((res) => res.cookies.delete(COOKIE.prepop));
      }
      if (!secret) log.error("proxy.prepop_disabled", { reason: "APP_SECRET missing" });

      // Strip every consumed param: the PII-bearing URL never renders a document, so it
      // can't reach analytics, page titles, history sync, or a Referer header.
      const clean = new URL(req.url);
      for (const k of [...clean.searchParams.keys()]) {
        if (CONSUMED_PARAMS.has(k.toLowerCase())) clean.searchParams.delete(k);
      }
      if (pathname === "/" && prepop.zip) clean.pathname = "/quote"; // ZIP known → skip the landing page
      const res = NextResponse.redirect(clean, 303);
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("Referrer-Policy", "no-referrer");
      applyVariantCookies(req, res, visitorId, params, isBot, cookieOpts);
      for (const fn of pending) fn(res);
      return res;
    }
  }

  // ---- variant + routing ----
  if (pathname === "/quote") {
    const target = req.nextUrl.clone();
    const decision = decide(req, visitorId, params, isBot);
    target.pathname = `/quote/v/${decision.variant}`;
    const res = NextResponse.rewrite(target);
    res.headers.set("Cache-Control", "private, no-store");
    if (writable) applyVariantCookies(req, res, visitorId, params, isBot, cookieOpts);
    for (const fn of pending) fn(res);
    return res;
  }

  const res = NextResponse.next();
  for (const fn of pending) fn(res);
  return res;
}

function decide(req: NextRequest, visitorId: string, params: URLSearchParams, isBot: boolean) {
  return resolveVariant({
    force: parseForceParam(params.get("variant")),
    overrideCookie: req.cookies.get(COOKIE.variantOverride)?.value,
    stickyCookie: req.cookies.get(COOKIE.variant)?.value,
    isBot,
    split: getSplitConfig(),
    visitorId,
  });
}

function applyVariantCookies(
  req: NextRequest,
  res: NextResponse,
  visitorId: string,
  params: URLSearchParams,
  isBot: boolean,
  cookieOpts: { httpOnly: boolean; secure: boolean; sameSite: "lax"; path: string },
): void {
  if (isBot) return;
  const d = decide(req, visitorId, params, isBot);
  // Session cookie (no maxAge): a tester's forced variant dies with the browser session.
  if (d.setOverride) res.cookies.set(COOKIE.variantOverride, d.setOverride, cookieOpts);
  else if (d.setOverride === null) res.cookies.delete(COOKIE.variantOverride);
  if (d.setSticky) res.cookies.set(COOKIE.variant, d.setSticky, { ...cookieOpts, maxAge: MAX_AGE.variant });
}

/** Affiliates send `Click_ID`, `EMAIL`...: match keys case-insensitively. */
function lowerCaseKeys(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of sp) {
    const key = k.toLowerCase();
    if (!out.has(key)) out.set(key, v);
  }
  return out;
}

export const config = {
  matcher: ["/", "/quote", "/quote/:path*"],
};
