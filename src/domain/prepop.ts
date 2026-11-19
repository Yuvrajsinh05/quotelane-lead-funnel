import { firstParam } from "./sanitize";
import {
  normalizeEmail,
  normalizeInsured,
  normalizeName,
  normalizePhone,
  normalizeYear,
  normalizeZip,
  type AgeRange,
  type VehicleMake,
} from "./fields";

/** Everything the visitor answers in the funnel. Canonical (normalized) values only. */
export interface Answers {
  zip?: string;
  vehicleYear?: number;
  vehicleMake?: VehicleMake;
  insured?: boolean;
  ageRange?: AgeRange;
  firstName?: string;
  lastName?: string;
  email?: string;
  /** 10-digit national number */
  phone?: string;
}
export type AnswerKey = keyof Answers;

export const PREPOP_KEYS = ["zip", "firstName", "lastName", "email", "phone", "vehicleYear", "insured"] as const;
export type PrepopKey = (typeof PREPOP_KEYS)[number];
export type Prepop = Pick<Answers, PrepopKey>;

/**
 * URL parameter names (incl. common aliases affiliates use) for each prepop field.
 * The first valid alias wins.
 */
const PREPOP_PARAM_ALIASES: Record<PrepopKey, readonly string[]> = {
  zip: ["zip", "zipcode", "zip_code", "postal_code"],
  firstName: ["first_name", "firstname", "fname"],
  lastName: ["last_name", "lastname", "lname"],
  email: ["email", "email_address"],
  phone: ["phone", "phone_number", "mobile"],
  vehicleYear: ["year", "vehicle_year"],
  insured: ["insured", "currently_insured"],
};

/** Every query key the proxy consumes for prepop — these get stripped from the address bar. */
export const PREPOP_PARAM_NAMES: readonly string[] = Object.values(PREPOP_PARAM_ALIASES).flat();

/** Keys that are personal data. Used for redaction decisions. */
export const PII_KEYS: ReadonlySet<PrepopKey> = new Set(["firstName", "lastName", "email", "phone"]);

/**
 * Parse prefill data from a URL. Invalid, junk, or macro values are dropped silently —
 * the corresponding step is then simply shown as normal.
 */
export function parsePrepop(params: URLSearchParams, now: Date = new Date()): Prepop {
  const out: Prepop = {};
  const get = (k: PrepopKey) => firstParam(params, PREPOP_PARAM_ALIASES[k]);

  const zip = get("zip");
  if (zip) {
    const v = normalizeZip(zip);
    if (v) out.zip = v;
  }
  const first = get("firstName");
  if (first) {
    const v = normalizeName(first);
    if (v) out.firstName = v;
  }
  const last = get("lastName");
  if (last) {
    const v = normalizeName(last);
    if (v) out.lastName = v;
  }
  const email = get("email");
  if (email) {
    const v = normalizeEmail(email);
    if (v) out.email = v;
  }
  const phone = get("phone");
  if (phone) {
    const v = normalizePhone(phone);
    if (v) out.phone = v;
  }
  const year = get("vehicleYear");
  if (year) {
    const v = normalizeYear(year, now);
    if (v) out.vehicleYear = v;
  }
  const insured = get("insured");
  if (insured) {
    const v = normalizeInsured(insured);
    if (v !== null) out.insured = v;
  }
  return out;
}

/**
 * Re-validate a prepop object that came back out of a cookie. Defends against an
 * old cookie format or a bug that wrote something invalid: never trust stored data blindly.
 */
export function revalidatePrepop(input: unknown, now: Date = new Date()): Prepop {
  if (!input || typeof input !== "object") return {};
  const src = input as Record<string, unknown>;
  const params = new URLSearchParams();
  const map: Record<PrepopKey, string> = {
    zip: "zip",
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phone: "phone",
    vehicleYear: "year",
    insured: "insured",
  };
  for (const key of PREPOP_KEYS) {
    const v = src[key];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") params.set(map[key], String(v));
  }
  return parsePrepop(params, now);
}
