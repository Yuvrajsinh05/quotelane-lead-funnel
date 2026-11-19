import { isIP } from "node:net";
import { NextResponse } from "next/server";

/**
 * Client IP from the platform. On Vercel, x-forwarded-for / x-real-ip are set by the
 * edge and client-supplied values are overwritten, so the first hop is trustworthy.
 * Behind a different proxy this must be revisited (see README). Never read from the body.
 */
export function clientIp(headers: Headers): string | null {
  const candidates = [headers.get("x-real-ip"), headers.get("x-forwarded-for")?.split(",")[0]];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && isIP(v)) return v;
  }
  return null;
}

export function json(body: unknown, status: number, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

/**
 * Cross-site request check. Browsers always send Origin on a cross-origin POST; if it
 * is present it must be ours. Absent Origin (curl, server-to-server) is allowed: rate
 * limiting and validation still apply, and CSRF needs a browser.
 */
export function isAllowedOrigin(headers: Headers, requestUrl: string): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  try {
    const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? new URL(requestUrl).host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
