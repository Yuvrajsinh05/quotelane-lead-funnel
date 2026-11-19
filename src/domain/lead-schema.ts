import { z } from "zod";
import {
  normalizeAgeRange,
  normalizeEmail,
  normalizeInsured,
  normalizeMake,
  normalizeName,
  normalizePhone,
  normalizeYear,
  normalizeZip,
} from "./fields";
import { isConsentVersion, type ConsentVersion } from "./consent";

/**
 * Wrap a normalizer as a Zod field: accepts string (or number/boolean where natural),
 * outputs the canonical value, and reports a human message on failure.
 */
function field<T>(normalize: (s: string) => T | null, message: string) {
  return z
    .union([z.string(), z.number(), z.boolean()])
    .transform((raw, ctx): T => {
      const value = typeof raw === "string" ? raw : String(raw);
      if (value.length > 256) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      const out = normalize(value);
      if (out === null) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return out;
    });
}

export const MESSAGES = {
  zip: "Enter a valid 5-digit US ZIP code.",
  vehicleYear: "Choose your vehicle's year.",
  vehicleMake: "Choose your vehicle's make.",
  insured: "Let us know if you're currently insured.",
  ageRange: "Choose your age range.",
  firstName: "Enter your first name.",
  lastName: "Enter your last name.",
  email: "Enter a valid email address, like name@example.com.",
  phone: "Enter a valid 10-digit US phone number.",
} as const;

export const zipField = field(normalizeZip, MESSAGES.zip);
const yearField = field((s) => normalizeYear(s), MESSAGES.vehicleYear);
const makeField = field(normalizeMake, MESSAGES.vehicleMake);
const insuredField = field(normalizeInsured, MESSAGES.insured);
const ageField = field(normalizeAgeRange, MESSAGES.ageRange);
const firstNameField = field(normalizeName, MESSAGES.firstName);
const lastNameField = field(normalizeName, MESSAGES.lastName);
const emailField = field(normalizeEmail, MESSAGES.email);
const phoneField = field(normalizePhone, MESSAGES.phone);

const consentVersionField = z
  .string()
  .refine(isConsentVersion, { message: "Unknown consent version." })
  .transform((v) => v as ConsentVersion);

/** Page URL the visitor submitted from. Origin is checked server-side; query/hash are dropped. */
const pageUrlField = z
  .string()
  .max(2048)
  .transform((v, ctx) => {
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
      return `${u.origin}${u.pathname}`;
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid page URL." });
      return z.NEVER;
    }
  });

const common = {
  zip: zipField,
  insured: insuredField,
  firstName: firstNameField,
  lastName: lastNameField,
  email: emailField,
  phone: phoneField,
  consentVersion: consentVersionField,
  pageUrl: pageUrlField,
};

/**
 * Discriminated on the variant the visitor actually rendered. Variant B never asks
 * for year/make/age, so they are absent (and ignored if sent).
 */
export const leadSubmissionSchema = z.discriminatedUnion("variant", [
  z.object({
    variant: z.literal("a"),
    vehicleYear: yearField,
    vehicleMake: makeField,
    ageRange: ageField,
    ...common,
  }),
  z.object({ variant: z.literal("b"), ...common }),
]);

export type LeadSubmission = z.output<typeof leadSubmissionSchema>;

/** Flatten Zod issues into { field: message } for the client. First message per field wins. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "_form");
    if (!(key in out)) {
      out[key] =
        issue.code === "invalid_type" && key in MESSAGES ? MESSAGES[key as keyof typeof MESSAGES] : issue.message;
    }
  }
  return out;
}
