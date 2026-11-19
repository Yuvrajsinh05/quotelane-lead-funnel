import { hmacHex } from "../crypto/seal";

export interface SendResult {
  ok: boolean;
  /** Worth retrying: timeout, network error, 408/425/429, 5xx. */
  retryable: boolean;
  httpStatus: number | null;
  errorClass: string | null;
  durationMs: number;
}

export interface SendOptions {
  url: string;
  body: string;
  idempotencyKey: string;
  timeoutMs: number;
  signingSecret?: string;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429]);

/**
 * One HTTP attempt. Never throws: every outcome is classified so the outbox can decide
 * what to do. The response body is discarded unread (partners sometimes echo PII back).
 */
export async function sendToPartner(opts: SendOptions): Promise<SendResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = performance.now();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "QuoteLane-LeadDelivery/1.0",
    // Lets the partner drop a repeat if our retry follows a request they actually received.
    "idempotency-key": opts.idempotencyKey,
  };
  if (opts.signingSecret) {
    const ts = Math.floor(Date.now() / 1000).toString();
    headers["x-quotelane-timestamp"] = ts;
    headers["x-quotelane-signature"] = `v1=${await hmacHex(opts.signingSecret, `${ts}.${opts.body}`)}`;
  }

  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers,
      body: opts.body,
      signal: AbortSignal.timeout(opts.timeoutMs),
      redirect: "error",
      cache: "no-store",
    });
    // Drain without reading into memory/logs so the socket can be reused.
    await res.body?.cancel().catch(() => {});
    const durationMs = Math.round(performance.now() - started);
    if (res.ok) return { ok: true, retryable: false, httpStatus: res.status, errorClass: null, durationMs };
    const retryable = res.status >= 500 || RETRYABLE_STATUS.has(res.status);
    return { ok: false, retryable, httpStatus: res.status, errorClass: `http_${res.status}`, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const name = (err as { name?: string })?.name;
    const errorClass = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
    return { ok: false, retryable: true, httpStatus: null, errorClass, durationMs };
  }
}
