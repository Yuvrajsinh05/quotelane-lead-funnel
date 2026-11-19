/**
 * Field normalizers + validators. Shared by:
 *   - prepop parsing (proxy)       → silently drop invalid values
 *   - the client funnel            → instant, friendly errors
 *   - POST /api/leads (Zod schema) → the authority
 *
 * Each normalizer returns the canonical value or `null` if invalid. Keeping them
 * as plain functions (not Zod-only) lets the proxy use them without building schemas.
 */

// ---------- ZIP ----------

const ZIP_RE = /^(\d{5})(?:-?\d{4})?$/;

export function normalizeZip(input: string): string | null {
  const compact = input.replace(/\s+/g, "");
  const m = ZIP_RE.exec(compact);
  if (!m) return null;
  const zip = m[1]!;
  // 000xx prefixes are not assigned by USPS; 00000 is the classic junk value.
  if (zip.startsWith("000")) return null;
  return zip;
}

// ---------- Names ----------

// Letters from any script, plus the punctuation real names use. Must start with a letter.
const NAME_RE = /^\p{L}[\p{L}\p{M}'’. -]{0,49}$/u;

export function normalizeName(input: string): string | null {
  const value = input.replace(/\s+/g, " ").trim();
  if (!NAME_RE.test(value)) return null;
  // Fix ALL-CAPS / all-lower values that commonly come from affiliate CSVs;
  // leave mixed case (McDonald, DeShawn) untouched.
  if (value === value.toUpperCase() || value === value.toLowerCase()) {
    return value.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  return value;
}

// ---------- Email ----------

// Pragmatic RFC-5322 subset: what real inboxes accept. Requires a dotted domain with an alpha TLD.
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;

export function normalizeEmail(input: string): string | null {
  // An unencoded '+' in a query string decodes to a space ("sam+quotes@x.com" → "sam quotes@x.com").
  // Spaces are never legal in an address, so restoring '+' is safe.
  const value = input.trim().replace(/ /g, "+").toLowerCase();
  if (value.length > 254) return null;
  const [local] = value.split("@");
  if (!local || local.length > 64) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!EMAIL_RE.test(value)) return null;
  return value;
}

// ---------- Phone (US / NANP) ----------

/**
 * Returns the 10-digit national number, or null.
 *
 * Structural rules: 10 digits (an 11-digit number must start with country code 1),
 * the area code starts with 2-9 and isn't an N11 service code, the exchange isn't an
 * N11 code, and the number isn't one repeated digit.
 *
 * Deliberately NOT enforced: the NANP rule that the exchange starts with 2-9. The spec's
 * own example "+1 (555) 123-4567" has exchange 123, so enforcing it would reject the
 * exact input we're told to accept. Real deliverability belongs to a carrier/HLR lookup
 * before the partner hand-off (listed in the README's pre-production changes).
 */
export function normalizePhone(input: string): string | null {
  if (/\p{L}/u.test(input)) return null; // any letters → junk ("abc", "call me"); extensions unsupported
  let digits = input.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return null;
  const npa = digits.slice(0, 3);
  const nxx = digits.slice(3, 6);
  if (!/^[2-9]\d\d$/.test(npa)) return null;
  if (npa.slice(1) === "11" || nxx.slice(1) === "11") return null;
  if (/^(\d)\1{9}$/.test(digits)) return null;
  return digits;
}

export const toE164 = (national10: string): string => `+1${national10}`;

export function formatPhoneDisplay(national10: string): string {
  return `(${national10.slice(0, 3)}) ${national10.slice(3, 6)}-${national10.slice(6)}`;
}

// ---------- Vehicle year ----------

/** 1981 is when the 17-character VIN was standardized; older vehicles are a different product. */
export const MIN_VEHICLE_YEAR = 1981;
export const maxVehicleYear = (now: Date = new Date()): number => now.getUTCFullYear() + 1;

export function normalizeYear(input: string, now: Date = new Date()): number | null {
  const value = input.trim();
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  if (year < MIN_VEHICLE_YEAR || year > maxVehicleYear(now)) return null;
  return year;
}

export function vehicleYearOptions(now: Date = new Date()): number[] {
  const out: number[] = [];
  for (let y = maxVehicleYear(now); y >= MIN_VEHICLE_YEAR; y--) out.push(y);
  return out;
}

// ---------- Insured ----------

const TRUTHY = new Set(["yes", "y", "true", "1", "on"]);
const FALSY = new Set(["no", "n", "false", "0", "off"]);

export function normalizeInsured(input: string): boolean | null {
  const v = input.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

// ---------- Make ----------

export const VEHICLE_MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Ford", "GMC",
  "Honda", "Hyundai", "Infiniti", "Jeep", "Kia", "Lexus", "Lincoln", "Mazda", "Mercedes-Benz",
  "Mitsubishi", "Nissan", "Ram", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo", "Other",
] as const;
export type VehicleMake = (typeof VEHICLE_MAKES)[number];
export const POPULAR_MAKES: readonly VehicleMake[] = [
  "Toyota", "Ford", "Chevrolet", "Honda", "Nissan", "Hyundai", "Jeep", "Kia",
];

export function normalizeMake(input: string): VehicleMake | null {
  const v = input.trim().toLowerCase();
  return VEHICLE_MAKES.find((m) => m.toLowerCase() === v) ?? null;
}

// ---------- Age range ----------

export const AGE_RANGES = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"] as const;
export type AgeRange = (typeof AGE_RANGES)[number];

export function normalizeAgeRange(input: string): AgeRange | null {
  const v = input.trim();
  return AGE_RANGES.find((a) => a === v) ?? null;
}
