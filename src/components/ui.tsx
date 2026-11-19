import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { forwardRef, useId } from "react";

export function SiteHeader() {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-bold tracking-tight text-brand-700" prefetch={false}>
          <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-brand-600 text-sm text-white">
            Q
          </span>
          QuoteLane
        </Link>
        <span className="flex items-center gap-1 text-xs text-muted">
          <LockIcon /> Secure &amp; free
        </span>
      </div>
    </header>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function PrimaryButton({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`focus-ring flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 text-lg font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {children}
    </button>
  );
}

export function OptionButton({
  selected,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...rest}
      className={`focus-ring min-h-14 w-full rounded-xl border-2 px-4 py-3 text-left text-base font-medium transition ${
        selected
          ? "border-brand-600 bg-brand-50 text-brand-700"
          : "border-slate-200 bg-white text-ink hover:border-brand-500"
      }`}
    >
      {children}
    </button>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: ReactNode;
}

export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, error, hint, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const errId = `${inputId}-err`;
  const hintId = `${inputId}-hint`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[error ? errId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined}
        {...rest}
        className={`focus-ring h-13 w-full rounded-xl border-2 bg-white px-4 text-base transition ${
          error ? "border-red-500" : "border-slate-200 focus:border-brand-500"
        }`}
      />
      {hint && !error ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? <FieldError id={errId}>{error}</FieldError> : null}
    </div>
  );
});

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-sm font-medium text-red-600">
      <span aria-hidden>⚠</span>
      {children}
    </p>
  );
}

export function PrefilledNote() {
  return (
    <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700">
      We filled this in from your link. Change it if it&apos;s not right.
    </p>
  );
}
