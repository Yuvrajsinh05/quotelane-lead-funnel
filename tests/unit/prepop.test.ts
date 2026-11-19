import { describe, expect, it } from "vitest";
import { parsePrepop, revalidatePrepop } from "@/domain/prepop";
import { cleanParam, isMacro } from "@/domain/sanitize";

const NOW = new Date("2026-11-19T00:00:00Z");
const fromQuery = (q: string) => parsePrepop(new URLSearchParams(q), NOW);

describe("cleanParam / macro detection", () => {
  it.each(["{sub5}", "{aff_sub5}", "[EMAIL]", "%%email%%", "{replace_it}", "{{first_name}}", "$email$", "<email>", "#zip#"])(
    "treats unreplaced macro %s as missing",
    (v) => {
      expect(isMacro(v)).toBe(true);
      expect(cleanParam(v)).toBeNull();
    },
  );

  it.each(["null", "undefined", "NULL", "none", "n/a", "", "   "])("treats null-ish %j as missing", (v) => {
    expect(cleanParam(v)).toBeNull();
  });

  it("trims and collapses whitespace, strips control chars", () => {
    expect(cleanParam("  90210 ")).toBe("90210");
    expect(cleanParam("Sam\u0000​ ")).toBe("Sam");
  });

  it("decodes a second, residual layer of percent-encoding", () => {
    expect(cleanParam("sam%40example.com")).toBe("sam@example.com");
  });

  it("rejects absurdly long values", () => {
    expect(cleanParam("a".repeat(600))).toBeNull();
  });
});

describe("parsePrepop — the spec's example link", () => {
  it("prefills valid values and ignores the unreplaced {sub5} year", () => {
    const p = fromQuery("click_id=abc123&aff_id=42&channel=email&zip=90210&first_name=Sam&email=sam%40example.com&insured=yes&year={sub5}");
    expect(p).toEqual({ zip: "90210", firstName: "Sam", email: "sam@example.com", insured: true });
  });
});

describe("parsePrepop — junk values are ignored", () => {
  it.each([
    ["zip=1234", {}],
    ["zip=00000", {}],
    ["phone=abc", {}],
    ["email=notanemail", {}],
    ["year=1850", {}],
    ["year=2099", {}],
    ["insured=maybe", {}],
    ["first_name=12345", {}],
    ["email=[EMAIL]", {}],
    ["email=%%email%%", {}],
  ])("%s → %j", (q, expected) => {
    expect(fromQuery(q)).toEqual(expected);
  });
});

describe("parsePrepop — messy but valid values are normalized", () => {
  it("phone '+1 (555) 123-4567' (with + decoded to a space by the URL parser)", () => {
    expect(fromQuery("phone=+1 (555) 123-4567").phone).toBe("5551234567");
    expect(fromQuery("phone=%2B1%20(555)%20123-4567").phone).toBe("5551234567");
  });
  it("zip with spaces and ZIP+4", () => {
    expect(fromQuery("zip=%2090210%20").zip).toBe("90210");
    expect(fromQuery("zip=90210-1234").zip).toBe("90210");
  });
  it("mixed / upper case", () => {
    expect(fromQuery("email=SAM@Example.COM").email).toBe("sam@example.com");
    expect(fromQuery("first_name=SAM").firstName).toBe("Sam");
    expect(fromQuery("first_name=mary-jane").firstName).toBe("Mary-Jane");
    expect(fromQuery("last_name=McDonald").lastName).toBe("McDonald");
    expect(fromQuery("insured=YES").insured).toBe(true);
    expect(fromQuery("insured=No").insured).toBe(false);
  });
  it("double-encoded email and unencoded '+' in the local part", () => {
    expect(fromQuery("email=sam%2540example.com").email).toBe("sam@example.com");
    expect(fromQuery("email=sam+quotes@example.com").email).toBe("sam+quotes@example.com");
  });
  it("accepts aliases", () => {
    expect(fromQuery("vehicle_year=2019&fname=Ana&zipcode=10001")).toEqual({ vehicleYear: 2019, firstName: "Ana", zip: "10001" });
  });
});

describe("revalidatePrepop", () => {
  it("re-validates values read back from storage", () => {
    expect(revalidatePrepop({ zip: "00000", email: "x@y.co", insured: false, phone: 5551234567 }, NOW)).toEqual({
      email: "x@y.co",
      insured: false,
      phone: "5551234567",
    });
    expect(revalidatePrepop("garbage")).toEqual({});
  });
});
