import { describe, expect, it } from "vitest";
import { isSearchBot } from "@/domain/bots";
import { firstUnansweredStep, nextStep, prevStep, progress, resolveStep } from "@/domain/steps";
import { mergeTracking, parseTracking, revalidateTracking } from "@/domain/tracking";
import { decodeTrackingCookie, encodeTrackingCookie } from "@/domain/tracking-cookie";

const q = (s: string) => new URLSearchParams(s);

describe("parseTracking", () => {
  it("captures the spec's params", () => {
    expect(parseTracking(q("click_id=abc123&aff_id=42&channel=email"))).toEqual({ affClickId: "abc123", affId: "42", channel: "email" });
  });
  it("drops macros, junk and injection attempts without breaking", () => {
    expect(parseTracking(q("click_id={click_id}&aff_id=%%aff%%&channel=[CHANNEL]"))).toEqual({});
    expect(parseTracking(q("click_id=<script>alert(1)</script>&aff_id=42;drop table"))).toEqual({});
    expect(parseTracking(q(""))).toEqual({});
  });
  it("normalizes channel aliases and keeps unknown-but-valid channels for reporting", () => {
    expect(parseTracking(q("channel=SMS")).channel).toBe("sms");
    expect(parseTracking(q("channel=text")).channel).toBe("sms");
    expect(parseTracking(q("channel=push"))).toEqual({ channel: "unknown", channelRaw: "push" });
  });
  it("captures sub ids", () => {
    expect(parseTracking(q("sub1=a&sub3=c&sub5={sub5}")).subIds).toEqual({ sub1: "a", sub3: "c" });
  });
});

describe("mergeTracking (last click wins)", () => {
  const existing = { affClickId: "old", affId: "1", channel: "email" as const, qlClickId: "ql_01JABCDEFGHJKMNPQRSTVWXYZ0" };
  it("a new click id replaces the whole context", () => {
    const r = mergeTracking(existing, { affClickId: "new", affId: "2" });
    expect(r).toEqual({ tracking: { affClickId: "new", affId: "2" }, isNewClick: true });
  });
  it("no new click id keeps existing values and only fills gaps", () => {
    const r = mergeTracking(existing, { affId: "999", subIds: { sub1: "x" } });
    expect(r.isNewClick).toBe(false);
    expect(r.tracking.affId).toBe("1");
    expect(r.tracking.subIds).toEqual({ sub1: "x" });
  });
});

describe("tracking cookie", () => {
  it("round-trips and re-validates tampered values", () => {
    const enc = encodeTrackingCookie({ affClickId: "abc", affId: "42", channel: "sms" });
    expect(decodeTrackingCookie(enc)).toEqual({ affClickId: "abc", affId: "42", channel: "sms" });
    const tampered = btoa(JSON.stringify({ affClickId: "<x>", affId: "42" }));
    expect(decodeTrackingCookie(tampered)).toEqual({ affId: "42" });
    expect(decodeTrackingCookie("%%%not-base64")).toBeNull();
    expect(revalidateTracking({ qlClickId: "evil" })).toEqual({});
  });
});

describe("step engine", () => {
  it("lands on the first unanswered step", () => {
    expect(firstUnansweredStep("a", {})).toBe("zip");
    expect(firstUnansweredStep("a", { zip: "90210", vehicleYear: 2020 })).toBe("make");
  });
  it("lands straight on contact when every earlier answer is prefilled (variant B)", () => {
    expect(firstUnansweredStep("b", { zip: "90210", insured: true })).toBe("contact");
  });
  it("skips prefilled steps going forward, but Back still reaches them", () => {
    const a = { zip: "90210", insured: true };
    expect(nextStep("a", "zip", a)).toBe("year");
    expect(nextStep("a", "make", { ...a, vehicleYear: 2020, vehicleMake: "Ford" as const })).toBe("age"); // insured skipped
    expect(prevStep("a", "age")).toBe("insured");
    expect(prevStep("a", "zip")).toBeNull();
  });
  it("never lets a deep link jump past unanswered steps", () => {
    expect(resolveStep("a", "contact", { zip: "90210" })).toBe("year");
    expect(resolveStep("a", "zip", { zip: "90210", vehicleYear: 2020 })).toBe("zip");
    expect(resolveStep("b", "make", { zip: "90210" })).toBe("insured"); // step not in B
    expect(resolveStep("a", "garbage", {})).toBe("zip");
  });
  it("progress", () => {
    expect(progress("b", "contact")).toEqual({ index: 2, total: 3, percent: 100 });
    expect(progress("a", "zip").percent).toBe(17);
  });
});

describe("isSearchBot", () => {
  it.each([
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", true],
    ["Mozilla/5.0 (compatible; bingbot/2.0)", true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1", false],
    [null, false],
  ])("%s → %s", (ua, out) => expect(isSearchBot(ua)).toBe(out));
});
