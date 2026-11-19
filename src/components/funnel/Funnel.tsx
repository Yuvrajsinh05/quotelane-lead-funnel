"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { CURRENT_CONSENT_VERSION } from "@/domain/consent";
import type { AnswerKey, Answers, Prepop } from "@/domain/prepop";
import { nextStep, prevStep, progress, resolveStep, STEPS, type StepId } from "@/domain/steps";
import type { Variant } from "@/domain/variant";
import { funnelStore, useFunnelState } from "./store";
import { AgeStep, ContactStep, InsuredStep, MakeStep, YearStep, ZipStep } from "./steps";

const FIELD_STEP: Record<string, StepId> = {
  zip: "zip",
  vehicleYear: "year",
  vehicleMake: "make",
  insured: "insured",
  ageRange: "age",
  firstName: "contact",
  lastName: "contact",
  email: "contact",
  phone: "contact",
};

const STEP_FIELD: Partial<Record<StepId, AnswerKey>> = {
  zip: "zip",
  year: "vehicleYear",
  make: "vehicleMake",
  insured: "insured",
  age: "ageRange",
};

interface Props {
  variant: Variant;
  prepop: { nonce: string; values: Prepop } | null;
}

/**
 * One component renders both versions; `variant` only selects the step list.
 * The current step lives in `?step=` (pushState), so browser Back/Forward and refresh work.
 */
export function Funnel({ variant, prepop }: Props) {
  const state = useFunnelState();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [errorsVersion, setErrorsVersion] = useState(0);
  const [formError, setFormError] = useState<string>();

  // Before first paint: apply the affiliate prefill (once per nonce).
  useLayoutEffect(() => funnelStore.applyPrepop(prepop), [prepop]);

  const requested = searchParams.get("step");
  const step = state ? resolveStep(variant, requested, state.answers) : null;

  // Keep the URL honest if the requested step was clamped (deep link past unanswered steps, stale history entry).
  useEffect(() => {
    if (step && requested !== step) window.history.replaceState(window.history.state, "", `?step=${step}`);
  }, [step, requested]);

  const goTo = useCallback((s: StepId) => {
    window.history.pushState(null, "", `?step=${s}`);
    window.scrollTo({ top: 0 });
  }, []);

  const answerAndAdvance = useCallback(
    (current: StepId) => (patch: Partial<Answers>) => {
      funnelStore.setAnswers(patch);
      setServerErrors((e) => {
        const next = { ...e };
        for (const k of Object.keys(patch)) delete next[k];
        return next;
      });
      goTo(nextStep(variant, current, funnelStore.get().answers));
    },
    [goTo, variant],
  );

  async function submit(contact: Required<Pick<Answers, "firstName" | "lastName" | "email" | "phone">>) {
    if (submitting) return;
    funnelStore.setAnswers(contact);
    const { answers: a, idempotencyKey } = funnelStore.get();
    const body = {
      variant,
      zip: a.zip,
      insured: a.insured,
      ...(variant === "a" ? { vehicleYear: a.vehicleYear, vehicleMake: a.vehicleMake, ageRange: a.ageRange } : {}),
      ...contact,
      consentVersion: CURRENT_CONSENT_VERSION,
      pageUrl: `${window.location.origin}${window.location.pathname}`,
    };

    setSubmitting(true);
    setFormError(undefined);
    let res: Response;
    try {
      res = await fetch("/api/leads", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify(body),
      });
    } catch {
      // Same idempotency key on the next click, so a request that actually landed won't duplicate.
      setFormError("We couldn't reach our servers. Check your connection and try again.");
      setSubmitting(false);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as {
      leadId?: string;
      message?: string;
      fieldErrors?: Record<string, string>;
    };

    if (res.ok && data.leadId) {
      setDone(true);
      funnelStore.reset();
      router.replace(`/thank-you?ref=${encodeURIComponent(data.leadId)}`);
      return;
    }
    if (res.status === 422 && data.fieldErrors) {
      setServerErrors(data.fieldErrors);
      setErrorsVersion((v) => v + 1);
      const steps = STEPS[variant];
      const target = steps.find((s) => Object.keys(data.fieldErrors!).some((f) => FIELD_STEP[f] === s));
      if (target && target !== "contact") goTo(target);
      else if (!target) setFormError(data.message ?? "Please check your answers and try again.");
    } else {
      setFormError(data.message ?? "Something went wrong. Please try again.");
    }
    setSubmitting(false);
  }

  if (!state || !step || done) return <FunnelSkeleton />;

  const { index, total, percent } = progress(variant, step);
  const back = prevStep(variant, step);
  const prefilledSet = new Set<string>(state.prefilled);
  const stepField = STEP_FIELD[step];
  const common = {
    answers: state.answers,
    prefilled: stepField ? prefilledSet.has(stepField) : false,
    serverError: stepField ? serverErrors[stepField] : undefined,
    onAnswer: answerAndAdvance(step),
  };

  return (
    <div className="mx-auto max-w-xl px-4 pb-16 pt-4">
      <div className="mb-6 space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-muted">
          {back ? (
            <button
              type="button"
              // Always the previous step in the list, even if it was skipped on the way in (prefilled).
              onClick={() => goTo(back)}
              className="focus-ring -ml-2 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-semibold text-brand-700 hover:bg-brand-50"
            >
              <span aria-hidden>←</span> Back
            </button>
          ) : (
            <span />
          )}
          <span>
            Step {index + 1} of {total}
          </span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Form progress"
        >
          <div className="h-full rounded-full bg-brand-600 transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" key={step}>
        {step === "zip" && <ZipStep {...common} title="What's your ZIP code?" />}
        {step === "year" && <YearStep {...common} />}
        {step === "make" && <MakeStep {...common} />}
        {step === "insured" && <InsuredStep {...common} />}
        {step === "age" && <AgeStep {...common} />}
        {step === "contact" && (
          <ContactStep
            key={errorsVersion}
            answers={state.answers}
            prefilledFields={prefilledSet}
            serverErrors={serverErrors}
            formError={formError}
            submitting={submitting}
            onChange={(patch) => funnelStore.setAnswers(patch)}
            onSubmit={submit}
          />
        )}
      </section>
    </div>
  );
}

function FunnelSkeleton() {
  return (
    <div className="mx-auto max-w-xl px-4 pt-4" aria-busy="true" aria-live="polite">
      <div className="mb-6 h-8 animate-pulse rounded bg-slate-200" />
      <div className="h-72 animate-pulse rounded-2xl bg-white shadow-sm" />
    </div>
  );
}
