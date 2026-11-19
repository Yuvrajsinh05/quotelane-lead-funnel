import type { Lead } from "../db/schema";

export interface ConsentRow {
  consentVersion: string;
  consentText: string;
  consentedAt: Date;
  ip: string | null;
  userAgent: string | null;
  pageUrl: string;
}

/**
 * The JSON contract we send to the partner. Versioned so the shape can evolve.
 *
 * Tracking fields:
 *  - click_id / aff_id: the AFFILIATE's values, so the partner can attribute and post back.
 *  - sub_id: OUR click id, brand-prefixed ("ql_…"). It travels in an existing field, which is
 *    how two brands sharing one partner account stay separable on the partner's side
 *    (filter sub_id by prefix) without needing a new field.
 *  - source_id: per-channel id agreed with the partner ("default" when a channel has none).
 */
export function buildPartnerPayload(lead: Lead, consent: ConsentRow, sourceId: string) {
  return {
    schema_version: 1,
    lead_id: lead.publicId,
    created_at: lead.createdAt.toISOString(),
    brand: lead.brand,
    test: lead.isTest,
    click_id: lead.affClickId,
    aff_id: lead.affId,
    sub_id: lead.qlClickId,
    source_id: sourceId,
    channel: lead.channel ?? "unknown",
    sub_ids: lead.subIds ?? {},
    variant: lead.variant,
    contact: {
      first_name: lead.firstName,
      last_name: lead.lastName,
      email: lead.email,
      phone: lead.phoneE164,
      zip: lead.zip,
    },
    vehicle: { year: lead.vehicleYear, make: lead.vehicleMake },
    driver: { currently_insured: lead.insured, age_range: lead.ageRange },
    consent: {
      version: consent.consentVersion,
      text: consent.consentText,
      consented_at: consent.consentedAt.toISOString(),
      ip: consent.ip,
      user_agent: consent.userAgent,
      page_url: consent.pageUrl,
    },
  };
}
