import { revalidateTracking, type Tracking } from "./tracking";

/**
 * The tracking cookie holds no PII, so it is encoded (base64url JSON), not encrypted.
 * It is still untrusted on the way back in: every read goes through revalidateTracking.
 */
export function encodeTrackingCookie(t: Tracking): string {
  return btoa(JSON.stringify(t)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeTrackingCookie(value: string | undefined | null): Tracking | null {
  if (!value || value.length > 4096) return null;
  try {
    const json = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return revalidateTracking(JSON.parse(json));
  } catch {
    return null;
  }
}
