import type { Metadata } from "next";
import { SiteHeader } from "@/components/ui";

export const metadata: Metadata = {
  title: "Thank You | QuoteLane",
  robots: { index: false, follow: false },
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export default async function ThankYouPage({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const { ref } = await searchParams;
  const reference = ref && ULID_RE.test(ref) ? ref : null;
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl px-4 py-12">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-8">
          <div aria-hidden className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">
            ✓
          </div>
          <h1 className="text-2xl font-bold tracking-tight">You&apos;re all set!</h1>
          <p className="mt-2 text-muted">
            We&apos;re matching you with quotes now. Expect to hear from our partners shortly by phone, text, or email.
          </p>
          {reference ? (
            <p className="mt-6 text-xs text-muted">
              Reference: <span className="font-mono">{reference}</span>
            </p>
          ) : null}
        </div>
      </main>
    </>
  );
}
