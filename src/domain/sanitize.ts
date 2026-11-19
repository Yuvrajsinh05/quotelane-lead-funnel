/**
 * Low-level cleaning shared by tracking + prepop parsing.
 *
 * Every value that arrives in a URL is hostile until proven otherwise: it may be
 * double-encoded, padded with whitespace, contain control characters, be an
 * unreplaced affiliate-network macro, or be a "null" string from a broken template.
 * This module turns any of that into either a clean string or `null`.
 */

/** Hard cap on any single raw value. Anything longer is junk, not data. */
export const MAX_RAW_LENGTH = 512;

/**
 * Unreplaced macro shapes used by affiliate networks / ESPs / SMS tools:
 *   {sub5} {{email}} [EMAIL] %%email%% $email$ <email> #email#
 * We match the *whole* value, then additionally reject any value containing
 * a brace or a `%%` pair, which never appear in legitimate field values.
 */
const MACRO_PATTERNS: readonly RegExp[] = [
  /^\{\{?[^{}]*\}?\}$/,
  /^\[[^[\]]*\]$/,
  /^%%[^%]*%%$/,
  /^\$[^$]+\$$/,
  /^<[^<>]*>$/,
  /^#[^#\s]+#$/,
];
const MACRO_FRAGMENT = /[{}]|%%|\[[A-Z_]+\]/;

/** Literal strings that broken templates emit instead of a value. */
const NULLISH = new Set(["null", "undefined", "none", "nil", "n/a", "na", "(null)", "-", "--", "nan", "false_value"]);

const CONTROL_CHARS = new RegExp("[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF]", "g");
const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/;

/**
 * URLSearchParams already decodes once. Some senders double-encode
 * (`sam%2540example.com` → `sam%40example.com`), so we attempt one more decode
 * if the value still looks percent-encoded. A malformed sequence is left as-is
 * and will fail field validation downstream.
 */
function decodeResidual(value: string): string {
  if (!PERCENT_ENCODED.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isMacro(value: string): boolean {
  return MACRO_PATTERNS.some((re) => re.test(value)) || MACRO_FRAGMENT.test(value);
}

export function isNullish(value: string): boolean {
  return NULLISH.has(value.toLowerCase());
}

/**
 * Normalize a raw query value into a clean string, or `null` when it is missing,
 * empty, oversized, an unreplaced macro, or a null-ish literal.
 */
export function cleanParam(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  if (raw.length > MAX_RAW_LENGTH) return null;

  const value = decodeResidual(raw)
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();

  if (value === "") return null;
  if (isNullish(value) || isMacro(value)) return null;
  return value;
}

/** First non-null cleaned value across a list of alias keys (e.g. `year`, `vehicle_year`). */
export function firstParam(params: URLSearchParams, keys: readonly string[]): string | null {
  for (const key of keys) {
    const v = cleanParam(params.get(key));
    if (v !== null) return v;
  }
  return null;
}
