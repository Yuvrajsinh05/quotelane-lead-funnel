import type { Answers } from "./prepop";
import type { Variant } from "./variant";
import { normalizeEmail, normalizeName, normalizePhone, normalizeYear, normalizeZip, normalizeAgeRange, normalizeMake } from "./fields";

export const STEP_IDS = ["zip", "year", "make", "insured", "age", "contact"] as const;
export type StepId = (typeof STEP_IDS)[number];

/**
 * The ONLY difference between the two versions of the form is this list.
 * Components, store, validation and submit are shared.
 */
export const STEPS: Record<Variant, readonly StepId[]> = {
  a: ["zip", "year", "make", "insured", "age", "contact"],
  b: ["zip", "insured", "contact"],
};

export const isStepId = (v: unknown): v is StepId => typeof v === "string" && (STEP_IDS as readonly string[]).includes(v);

/** Whether a single pre-contact step has a valid answer. Re-validates (answers may come from storage). */
export function isStepAnswered(step: StepId, a: Answers, now: Date = new Date()): boolean {
  switch (step) {
    case "zip":
      return !!a.zip && normalizeZip(a.zip) === a.zip;
    case "year":
      return a.vehicleYear != null && normalizeYear(String(a.vehicleYear), now) === a.vehicleYear;
    case "make":
      return !!a.vehicleMake && normalizeMake(a.vehicleMake) === a.vehicleMake;
    case "insured":
      return typeof a.insured === "boolean";
    case "age":
      return !!a.ageRange && normalizeAgeRange(a.ageRange) === a.ageRange;
    case "contact":
      // The contact step is where consent is given, so it is never auto-skipped.
      return false;
  }
}

export function isContactComplete(a: Answers): boolean {
  return (
    !!a.firstName && !!normalizeName(a.firstName) &&
    !!a.lastName && !!normalizeName(a.lastName) &&
    !!a.email && !!normalizeEmail(a.email) &&
    !!a.phone && !!normalizePhone(a.phone)
  );
}

/** Where the visitor should land: the first step without a valid answer. */
export function firstUnansweredStep(variant: Variant, a: Answers, now: Date = new Date()): StepId {
  return STEPS[variant].find((s) => !isStepAnswered(s, a, now)) ?? "contact";
}

/**
 * Clamp a requested step (from ?step=) to one the visitor is allowed to be on:
 * it must exist in this variant, and every step before it must be answered
 * (no deep-linking past unanswered questions). Steps BEFORE the frontier are
 * always reachable — that's how "back" reaches skipped, prefilled steps.
 */
export function resolveStep(variant: Variant, requested: string | null, a: Answers, now: Date = new Date()): StepId {
  const frontier = firstUnansweredStep(variant, a, now);
  if (!isStepId(requested)) return frontier;
  const steps = STEPS[variant];
  const idx = steps.indexOf(requested);
  if (idx === -1) return frontier;
  return idx <= steps.indexOf(frontier) ? requested : frontier;
}

export function nextStep(variant: Variant, current: StepId, a: Answers, now: Date = new Date()): StepId {
  const steps = STEPS[variant];
  const idx = steps.indexOf(current);
  // Skip forward over steps that are already answered (prefilled), but never past contact.
  for (let i = idx + 1; i < steps.length; i++) {
    const s = steps[i]!;
    if (!isStepAnswered(s, a, now)) return s;
  }
  return "contact";
}

/** Back walks through EVERY step, including ones that were skipped because they were prefilled. */
export function prevStep(variant: Variant, current: StepId): StepId | null {
  const steps = STEPS[variant];
  const idx = steps.indexOf(current);
  return idx > 0 ? steps[idx - 1]! : null;
}

export function progress(variant: Variant, current: StepId): { index: number; total: number; percent: number } {
  const steps = STEPS[variant];
  const index = Math.max(0, steps.indexOf(current));
  const total = steps.length;
  return { index, total, percent: Math.round(((index + 1) / total) * 100) };
}
