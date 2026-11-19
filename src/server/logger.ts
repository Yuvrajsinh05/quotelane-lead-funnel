/**
 * Structured JSON logger with an ALLOW-LIST.
 *
 * A deny-list ("redact email, phone...") fails open: the day someone logs `{ body }`
 * or adds a new field, PII leaks. Here only keys in SAFE_KEYS are written verbatim;
 * anything else is replaced with "[redacted]". Errors are reduced to name + first line
 * of the message (Postgres errors can echo row values in DETAIL lines).
 */
const SAFE_KEYS = new Set([
  "requestId", "leadId", "publicId", "variant", "variantSource", "status", "httpStatus",
  "attempt", "attempts", "durationMs", "errorClass", "path", "method", "reason", "count", "channel",
  "routingProfile", "routingFallback", "brand", "retryable", "outcome", "splitPercentB", "limit",
  "windowSeconds", "fields", "claimed", "processed", "partnerConfigured", "isBot", "isNewClick", "test", "exhausted", "purged",
]);

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function scrub(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === "err") {
      out.err =
        v instanceof Error ? { name: v.name, message: (v.message.split("\n")[0] ?? "").slice(0, 200) } : "[non-error]";
    } else if (SAFE_KEYS.has(k)) {
      out[k] = v;
    } else {
      out[k] = "[redacted]";
    }
  }
  return out;
}

function write(level: Level, event: string, fields: Fields = {}): void {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), event, ...scrub(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};

export const __test = { scrub };
