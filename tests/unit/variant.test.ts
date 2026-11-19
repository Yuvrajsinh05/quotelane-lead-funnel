import { describe, expect, it } from "vitest";
import { bucketOf, parseSplitPercent, resolveVariant, type VariantInput } from "@/domain/variant";

const base: VariantInput = {
  force: null,
  overrideCookie: undefined,
  stickyCookie: undefined,
  isBot: false,
  split: { percentB: 50, valid: true },
  visitorId: "visitor-1",
};

describe("parseSplitPercent", () => {
  it.each([
    ["0", 0, true],
    ["37", 37, true],
    ["100", 100, true],
    [" 25 ", 25, true],
    ["101", 0, false],
    ["-5", 0, false],
    ["abc", 0, false],
    ["12.5", 0, false],
    [undefined, 0, false],
  ])("%j → %d (valid=%s)", (raw, pct, valid) => expect(parseSplitPercent(raw)).toEqual({ percentB: pct, valid }));
});

describe("resolveVariant", () => {
  it("assigns new visitors by bucket and makes it sticky", () => {
    const d = resolveVariant(base);
    expect(d.source).toBe("assigned");
    expect(d.setSticky).toBe(d.variant);
    expect(d.variant).toBe(bucketOf("visitor-1") < 50 ? "b" : "a");
  });

  it("is sticky: changing the split never reshuffles an assigned visitor", () => {
    for (const pct of [1, 10, 50, 90, 99]) {
      expect(resolveVariant({ ...base, stickyCookie: "b", split: { percentB: pct, valid: true } })).toEqual({ variant: "b", source: "sticky" });
      expect(resolveVariant({ ...base, stickyCookie: "a", split: { percentB: pct, valid: true } })).toEqual({ variant: "a", source: "sticky" });
    }
  });

  it("split percentage is honoured across a population", () => {
    let b = 0;
    for (let i = 0; i < 10_000; i++) if (resolveVariant({ ...base, visitorId: crypto.randomUUID(), split: { percentB: 30, valid: true } }).variant === "b") b++;
    expect(b / 10_000).toBeGreaterThan(0.27);
    expect(b / 10_000).toBeLessThan(0.33);
  });

  it("raising the split only moves visitors A→B (buckets are fixed)", () => {
    for (let i = 0; i < 500; i++) {
      const visitorId = crypto.randomUUID();
      const low = resolveVariant({ ...base, visitorId, split: { percentB: 20, valid: true } }).variant;
      const high = resolveVariant({ ...base, visitorId, split: { percentB: 60, valid: true } }).variant;
      if (low === "b") expect(high).toBe("b");
    }
  });

  it("kill switch: 0 → everyone A, 100 → everyone B, sticky ignored but NOT rewritten", () => {
    expect(resolveVariant({ ...base, stickyCookie: "b", split: { percentB: 0, valid: true } })).toEqual({ variant: "a", source: "killswitch" });
    expect(resolveVariant({ ...base, stickyCookie: "a", split: { percentB: 100, valid: true } })).toEqual({ variant: "b", source: "killswitch" });
  });

  it("invalid config falls back to 0 (control)", () => {
    expect(resolveVariant({ ...base, split: parseSplitPercent("banana") }).variant).toBe("a");
  });

  it("search bots always get A with no cookies", () => {
    expect(resolveVariant({ ...base, isBot: true, stickyCookie: "b", split: { percentB: 100, valid: true } })).toEqual({ variant: "a", source: "bot" });
  });

  it("?variant= forces, sets a session override, never touches sticky, and beats the kill switch", () => {
    const d = resolveVariant({ ...base, force: "b", stickyCookie: "a", split: { percentB: 0, valid: true } });
    expect(d).toEqual({ variant: "b", source: "forced", setOverride: "b" });
    expect(d.setSticky).toBeUndefined();
  });

  it("override cookie keeps the tester on the forced version across steps", () => {
    expect(resolveVariant({ ...base, overrideCookie: "b", split: { percentB: 0, valid: true } })).toEqual({ variant: "b", source: "forced" });
  });

  it("?variant=clear drops the override and falls back to normal rules", () => {
    expect(resolveVariant({ ...base, force: "clear", overrideCookie: "b", stickyCookie: "a" })).toEqual({
      variant: "a",
      source: "sticky",
      setOverride: null,
    });
  });

  it("ignores garbage cookie values", () => {
    expect(resolveVariant({ ...base, stickyCookie: "z", overrideCookie: "<script>" }).source).toBe("assigned");
  });
});
