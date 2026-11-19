"use client";

import { useState, type FormEvent } from "react";
import { CURRENT_CONSENT_TEXT, SUBMIT_LABEL } from "@/domain/consent";
import {
  AGE_RANGES,
  POPULAR_MAKES,
  VEHICLE_MAKES,
  formatPhoneDisplay,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeZip,
  vehicleYearOptions,
  type AgeRange,
  type VehicleMake,
} from "@/domain/fields";
import { MESSAGES } from "@/domain/lead-schema";
import type { Answers } from "@/domain/prepop";
import { FieldError, OptionButton, PrefilledNote, PrimaryButton, TextField } from "../ui";

export interface StepProps {
  answers: Answers;
  prefilled: boolean;
  /** Error from the server for this step's field(s), if a submit bounced back here. */
  serverError?: string;
  onAnswer: (patch: Partial<Answers>) => void;
}

function Title({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-5 space-y-1">
      <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink">{children}</h1>
      {sub ? <p className="text-sm text-muted">{sub}</p> : null}
    </div>
  );
}

// ---------- ZIP ----------

export function ZipStep({
  answers,
  prefilled,
  serverError,
  onAnswer,
  cta = "Continue",
  title,
}: StepProps & { cta?: string; title?: string }) {
  const [value, setValue] = useState(answers.zip ?? "");
  const [error, setError] = useState<string | undefined>(serverError);
  function submit(e: FormEvent) {
    e.preventDefault();
    const zip = normalizeZip(value);
    if (!zip) return setError(MESSAGES.zip);
    onAnswer({ zip });
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {title ? <Title>{title}</Title> : null}
      <TextField
        label="ZIP code"
        name="zip"
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={10}
        placeholder="e.g. 90210"
        value={value}
        error={error}
        onChange={(e) => {
          setValue(e.target.value);
          setError(undefined);
        }}
      />
      {prefilled ? <PrefilledNote /> : null}
      <PrimaryButton type="submit">{cta}</PrimaryButton>
    </form>
  );
}

// ---------- Vehicle year ----------

export function YearStep({ answers, prefilled, serverError, onAnswer }: StepProps) {
  const years = vehicleYearOptions();
  const recent = years.slice(0, 8);
  const [showAll, setShowAll] = useState(answers.vehicleYear != null && !recent.includes(answers.vehicleYear));
  const [error, setError] = useState<string | undefined>(serverError);
  return (
    <div className="space-y-4">
      <Title>What year is your vehicle?</Title>
      {prefilled ? <PrefilledNote /> : null}
      <div className="grid grid-cols-2 gap-3">
        {recent.map((y) => (
          <OptionButton key={y} selected={answers.vehicleYear === y} onClick={() => onAnswer({ vehicleYear: y })}>
            {y}
          </OptionButton>
        ))}
      </div>
      {showAll ? (
        <div className="space-y-1.5">
          <label htmlFor="year-older" className="block text-sm font-semibold">
            Older vehicle
          </label>
          <select
            id="year-older"
            className="focus-ring h-13 w-full rounded-xl border-2 border-slate-200 bg-white px-4"
            value={answers.vehicleYear ?? ""}
            onChange={(e) => {
              const y = Number(e.target.value);
              if (y) onAnswer({ vehicleYear: y });
              else setError(MESSAGES.vehicleYear);
            }}
          >
            <option value="">Select year</option>
            {years.slice(8).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <button type="button" className="text-sm font-semibold text-brand-600 underline" onClick={() => setShowAll(true)}>
          My vehicle is older than {recent[recent.length - 1]}
        </button>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

// ---------- Make ----------

export function MakeStep({ answers, serverError, onAnswer }: StepProps) {
  const current = answers.vehicleMake;
  const others = VEHICLE_MAKES.filter((m) => !POPULAR_MAKES.includes(m));
  return (
    <div className="space-y-4">
      <Title>What make is your {answers.vehicleYear ?? ""} vehicle?</Title>
      <div className="grid grid-cols-2 gap-3">
        {POPULAR_MAKES.map((m) => (
          <OptionButton key={m} selected={current === m} onClick={() => onAnswer({ vehicleMake: m })}>
            {m}
          </OptionButton>
        ))}
      </div>
      <div className="space-y-1.5">
        <label htmlFor="make-other" className="block text-sm font-semibold">
          Other make
        </label>
        <select
          id="make-other"
          className="focus-ring h-13 w-full rounded-xl border-2 border-slate-200 bg-white px-4"
          value={current && !POPULAR_MAKES.includes(current) ? current : ""}
          onChange={(e) => e.target.value && onAnswer({ vehicleMake: e.target.value as VehicleMake })}
        >
          <option value="">Select make</option>
          {others.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>
      {serverError ? <FieldError>{serverError}</FieldError> : null}
    </div>
  );
}

// ---------- Insured ----------

export function InsuredStep({ answers, prefilled, serverError, onAnswer }: StepProps) {
  return (
    <div className="space-y-4">
      <Title sub="Drivers with continuous coverage often qualify for lower rates.">Are you insured right now?</Title>
      {prefilled ? <PrefilledNote /> : null}
      <div className="grid gap-3">
        <OptionButton selected={answers.insured === true} onClick={() => onAnswer({ insured: true })}>
          Yes, I have auto insurance
        </OptionButton>
        <OptionButton selected={answers.insured === false} onClick={() => onAnswer({ insured: false })}>
          No, I&apos;m not currently insured
        </OptionButton>
      </div>
      {serverError ? <FieldError>{serverError}</FieldError> : null}
    </div>
  );
}

// ---------- Age ----------

export function AgeStep({ answers, serverError, onAnswer }: StepProps) {
  return (
    <div className="space-y-4">
      <Title>How old are you?</Title>
      <div className="grid grid-cols-2 gap-3">
        {AGE_RANGES.map((a: AgeRange) => (
          <OptionButton key={a} selected={answers.ageRange === a} onClick={() => onAnswer({ ageRange: a })}>
            {a}
          </OptionButton>
        ))}
      </div>
      {serverError ? <FieldError>{serverError}</FieldError> : null}
    </div>
  );
}

// ---------- Contact (final step: consent + submit) ----------

type ContactField = "firstName" | "lastName" | "email" | "phone";

export interface ContactStepProps {
  answers: Answers;
  prefilledFields: ReadonlySet<string>;
  serverErrors: Partial<Record<ContactField, string>>;
  formError?: string;
  submitting: boolean;
  onChange: (patch: Partial<Answers>) => void;
  onSubmit: (values: Required<Pick<Answers, ContactField>>) => void;
}

export function ContactStep({ answers, prefilledFields, serverErrors, formError, submitting, onChange, onSubmit }: ContactStepProps) {
  const [values, setValues] = useState({
    firstName: answers.firstName ?? "",
    lastName: answers.lastName ?? "",
    email: answers.email ?? "",
    phone: answers.phone ? formatPhoneDisplay(answers.phone) : "",
  });
  // Seeded from the server once; the parent remounts this step (new `key`) when a new
  // set of server errors arrives, so no effect is needed to sync them.
  const [errors, setErrors] = useState<Partial<Record<ContactField, string>>>(serverErrors);

  function validate() {
    const firstName = normalizeName(values.firstName);
    const lastName = normalizeName(values.lastName);
    const email = normalizeEmail(values.email);
    const phone = normalizePhone(values.phone);
    const next: Partial<Record<ContactField, string>> = {};
    if (!firstName) next.firstName = MESSAGES.firstName;
    if (!lastName) next.lastName = MESSAGES.lastName;
    if (!email) next.email = MESSAGES.email;
    if (!phone) next.phone = MESSAGES.phone;
    return { next, parsed: firstName && lastName && email && phone ? { firstName, lastName, email, phone } : null };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const { next, parsed } = validate();
    setErrors(next);
    if (!parsed) {
      const order: ContactField[] = ["firstName", "lastName", "email", "phone"];
      const first = order.find((k) => next[k]);
      if (first) document.getElementById(`contact-${first}`)?.focus();
      return;
    }
    onSubmit(parsed);
  }

  const bind = (k: ContactField) => ({
    id: `contact-${k}`,
    name: k,
    value: values[k],
    error: errors[k],
    hint: prefilledFields.has(k) ? "Filled in from your link. Edit if needed." : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      setValues((v) => ({ ...v, [k]: e.target.value }));
      setErrors((x) => ({ ...x, [k]: undefined }));
    },
    onBlur: () => {
      // Persist valid values as they're entered so a refresh doesn't lose them.
      const norm =
        k === "phone" ? normalizePhone(values[k]) : k === "email" ? normalizeEmail(values[k]) : normalizeName(values[k]);
      if (norm) onChange({ [k]: norm });
    },
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Title sub="Last step. We'll match you with quotes for your area.">Where should we send your quotes?</Title>
      <div className="grid grid-cols-2 gap-3">
        <TextField label="First name" autoComplete="given-name" maxLength={50} {...bind("firstName")} />
        <TextField label="Last name" autoComplete="family-name" maxLength={50} {...bind("lastName")} />
      </div>
      <TextField label="Email" type="email" inputMode="email" autoComplete="email" maxLength={254} {...bind("email")} />
      <TextField label="Phone" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={20} placeholder="(555) 123-4567" {...bind("phone")} />

      {/* Consent text sits directly above the submit button, verbatim; clicking submit is the agreement. */}
      <p className="text-xs leading-relaxed text-muted" data-testid="consent-text">
        {CURRENT_CONSENT_TEXT}
      </p>
      {formError ? <FieldError>{formError}</FieldError> : null}
      <PrimaryButton type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? "Submitting…" : SUBMIT_LABEL}
      </PrimaryButton>
    </form>
  );
}
