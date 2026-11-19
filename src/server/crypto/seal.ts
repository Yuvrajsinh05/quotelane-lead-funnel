/**
 * AES-256-GCM sealing for cookies that carry personal data (prepop).
 *
 * - Confidentiality: the cookie is unreadable if it leaks (shared machine, proxy, logs).
 * - Integrity: GCM's auth tag means the browser cannot forge "this field was prefilled".
 * - Expiry is INSIDE the sealed payload, so a replayed old cookie is rejected even if
 *   the browser ignores Max-Age.
 *
 * Uses Web Crypto so it runs identically in the proxy and in route handlers.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function deriveKey(secret: string, purpose: string): Promise<CryptoKey> {
  const id = `${purpose}:${secret}`;
  let key = keyCache.get(id);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("quotelane/v1"), info: enc.encode(purpose) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(id, key);
  }
  return key;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function seal(data: unknown, secret: string, purpose: string, ttlSeconds: number): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = enc.encode(JSON.stringify({ d: data, e: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
  return `${b64url(iv)}.${b64url(ct)}`;
}

/** Returns the payload, or null if tampered, malformed, sealed with another key, or expired. */
export async function unseal<T = unknown>(token: string | undefined, secret: string, purpose: string): Promise<T | null> {
  if (!token || token.length > 4096) return null;
  const [ivPart, ctPart] = token.split(".");
  if (!ivPart || !ctPart) return null;
  try {
    const key = await deriveKey(secret, purpose);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(ivPart) }, key, fromB64url(ctPart));
    const parsed = JSON.parse(dec.decode(pt)) as { d: T; e: number };
    if (typeof parsed.e !== "number" || parsed.e < Math.floor(Date.now() / 1000)) return null;
    return parsed.d;
  } catch {
    return null;
  }
}

/** HMAC-SHA256 hex: IP hashing for rate-limit keys, and partner request signing. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const PURPOSE = { prepop: "cookie:prepop", ipHash: "hmac:ip", requestHash: "hmac:request" } as const;
