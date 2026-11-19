import { LandingZip } from "@/components/LandingZip";
import { SiteHeader } from "@/components/ui";
import { readPrepopForPage } from "@/server/page-context";

export const dynamic = "force-dynamic";

const POINTS = [
  { title: "2 minutes", body: "A few quick questions. No account needed." },
  { title: "Free to compare", body: "Comparing quotes never costs you anything." },
  { title: "Your choice", body: "Pick the coverage that fits. No obligation." },
];

export default async function LandingPage() {
  const prepop = await readPrepopForPage();
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-xl px-4 pb-16">
        <section className="pt-8 pb-6 sm:pt-12">
          <p className="mb-3 inline-block rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
            Auto insurance quotes
          </p>
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
            Drivers could save hundreds on car insurance.
          </h1>
          <p className="mt-3 text-base text-muted">Enter your ZIP code to compare rates from top providers in your area.</p>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <LandingZip prepop={prepop} />
        </section>

        <ul className="mt-8 grid gap-4 sm:grid-cols-3">
          {POINTS.map((p) => (
            <li key={p.title} className="rounded-xl bg-white p-4 text-sm shadow-sm ring-1 ring-slate-200">
              <p className="font-semibold text-ink">{p.title}</p>
              <p className="mt-1 text-muted">{p.body}</p>
            </li>
          ))}
        </ul>
      </main>
    </>
  );
}
