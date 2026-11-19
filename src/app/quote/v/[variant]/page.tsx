import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Funnel } from "@/components/funnel/Funnel";
import { SiteHeader } from "@/components/ui";
import { isVariant } from "@/domain/variant";
import { readPrepopForPage } from "@/server/page-context";

// Renders per-visitor prefill (PII): never cached, never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Get Your Quotes | QuoteLane",
  robots: { index: false, follow: false },
};

/**
 * Internal route. Visitors always see /quote; the proxy rewrites it here based on
 * their variant, and redirects direct hits on /quote/v/* back to /quote.
 */
export default async function QuotePage({ params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (!isVariant(variant)) notFound();
  const prepop = await readPrepopForPage();

  return (
    <>
      <SiteHeader />
      <main data-variant={variant}>
        <Suspense>
          <Funnel variant={variant} prepop={prepop} />
        </Suspense>
      </main>
    </>
  );
}
