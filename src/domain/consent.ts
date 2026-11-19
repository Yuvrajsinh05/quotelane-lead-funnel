/**
 * Consent language is versioned and immutable. The client tells the server WHICH
 * version it rendered; the server stores the text it holds for that version. A new
 * wording = a new version key, never an edit, so every historic consent record stays
 * provably tied to the exact words the visitor saw.
 */
export const CONSENT_TEXTS = {
  "2026-11-v1":
    "By clicking Get My Quotes, I agree that QuoteLane and its partners may contact me by phone, text and email, including by automated means, at the number provided. Consent is not a condition of purchase.",
} as const;

export type ConsentVersion = keyof typeof CONSENT_TEXTS;
export const CURRENT_CONSENT_VERSION: ConsentVersion = "2026-11-v1";
export const CURRENT_CONSENT_TEXT = CONSENT_TEXTS[CURRENT_CONSENT_VERSION];

export const isConsentVersion = (v: unknown): v is ConsentVersion =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(CONSENT_TEXTS, v);

export const SUBMIT_LABEL = "Get My Quotes";
