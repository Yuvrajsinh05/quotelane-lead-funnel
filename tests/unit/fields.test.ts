import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeName, normalizePhone, normalizeYear, normalizeZip } from "@/domain/fields";
import { leadSubmissionSchema } from "@/domain/lead-schema";
import { CURRENT_CONSENT_VERSION } from "@/domain/consent";

describe("normalizePhone (NANP)", () => {
  it.each([
    ["(555) 123-4567", "5551234567"],
    ["+1 555 123 4567", "5551234567"],
    ["1-212-555-0100", "2125550100"],
    ["212.555.0100", "2125550100"],
  ])("%s → %s", (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(["abc", "123", "555-1234", "0125551234", "1125551234", "4115551234", "2129111234", "2222222222", "+44 20 7946 0958"])(
    "rejects %s",
    (input) => expect(normalizePhone(input)).toBeNull(),
  );
});

describe("normalizeEmail", () => {
  it.each(["notanemail", "a@b", "a@b.c", "a..b@x.com", ".a@x.com", "a@-x.com", "a b@x.com x"])("rejects %s", (v) =>
    expect(normalizeEmail(v)).toBeNull(),
  );
  it("lower-cases", () => expect(normalizeEmail(" Sam@Example.COM ")).toBe("sam@example.com"));
});

describe("normalizeZip / normalizeYear / normalizeName", () => {
  it("zip", () => {
    expect(normalizeZip("00501")).toBe("00501");
    expect(normalizeZip("00012")).toBeNull();
    expect(normalizeZip("ABCDE")).toBeNull();
  });
  it("year bounds", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(normalizeYear("1981", now)).toBe(1981);
    expect(normalizeYear("1980", now)).toBeNull();
    expect(normalizeYear("2027", now)).toBe(2027);
    expect(normalizeYear("2028", now)).toBeNull();
  });
  it("names", () => {
    expect(normalizeName("José")).toBe("José");
    expect(normalizeName("o'brien")).toBe("O'Brien");
    expect(normalizeName("<script>")).toBeNull();
  });
});

describe("leadSubmissionSchema (server authority)", () => {
  const base = {
    zip: " 90210 ",
    insured: "yes",
    firstName: "sam",
    lastName: "LEE",
    email: "Sam@Example.com",
    phone: "+1 (555) 123-4567",
    consentVersion: CURRENT_CONSENT_VERSION,
    pageUrl: "https://quotelane.test/quote?email=leak@x.com#frag",
  };

  it("normalizes variant B and drops query/hash from the page URL", () => {
    const r = leadSubmissionSchema.parse({ ...base, variant: "b" });
    expect(r).toMatchObject({ zip: "90210", insured: true, firstName: "Sam", lastName: "Lee", email: "sam@example.com", phone: "5551234567" });
    expect(r.pageUrl).toBe("https://quotelane.test/quote");
  });

  it("requires vehicle questions for variant A", () => {
    const r = leadSubmissionSchema.safeParse({ ...base, variant: "a" });
    expect(r.success).toBe(false);
    const ok = leadSubmissionSchema.safeParse({ ...base, variant: "a", vehicleYear: 2020, vehicleMake: "honda", ageRange: "25-34" });
    expect(ok.success && ok.data.variant === "a" && ok.data.vehicleMake).toBe("Honda");
  });

  it("rejects unknown consent versions and unknown variants", () => {
    expect(leadSubmissionSchema.safeParse({ ...base, variant: "b", consentVersion: "v0" }).success).toBe(false);
    expect(leadSubmissionSchema.safeParse({ ...base, variant: "c" }).success).toBe(false);
  });
});
