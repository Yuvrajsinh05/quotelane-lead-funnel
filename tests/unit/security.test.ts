import { describe, expect, it, vi } from "vitest";
import { seal, unseal } from "@/server/crypto/seal";
import { __test } from "@/server/logger";

const SECRET = "x".repeat(40);

describe("seal / unseal", () => {
  it("round-trips", async () => {
    const t = await seal({ email: "a@b.co" }, SECRET, "p", 60);
    expect(await unseal(t, SECRET, "p")).toEqual({ email: "a@b.co" });
  });
  it("rejects tampering, wrong key, wrong purpose, garbage", async () => {
    const t = await seal({ a: 1 }, SECRET, "p", 60);
    const flipped = t.slice(0, -2) + (t.endsWith("A") ? "BB" : "AA");
    expect(await unseal(flipped, SECRET, "p")).toBeNull();
    expect(await unseal(t, "y".repeat(40), "p")).toBeNull();
    expect(await unseal(t, SECRET, "other")).toBeNull();
    expect(await unseal("nonsense", SECRET, "p")).toBeNull();
  });
  it("rejects expired payloads even if the browser kept the cookie", async () => {
    const t = await seal({ a: 1 }, SECRET, "p", 60);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(await unseal(t, SECRET, "p")).toBeNull();
    vi.useRealTimers();
  });
});

describe("logger allow-list", () => {
  it("redacts anything not explicitly safe, including PII and URLs", () => {
    const out = __test.scrub({ leadId: "L1", email: "a@b.co", phone: "555", url: "/?email=x", body: { a: 1 }, err: new Error("boom\nDETAIL: Key (email)=(a@b.co)") });
    expect(out).toEqual({
      leadId: "L1",
      email: "[redacted]",
      phone: "[redacted]",
      url: "[redacted]",
      body: "[redacted]",
      err: { name: "Error", message: "boom" },
    });
  });
});
