"use client";

import { useSyncExternalStore } from "react";
import { PREPOP_KEYS, type AnswerKey, type Answers, type Prepop } from "@/domain/prepop";

/**
 * Funnel state, shared by the landing page and both form versions.
 *
 * Persisted to sessionStorage: survives refresh and back/forward, is scoped to the tab,
 * and is cleared on submit. Holds answers only — tracking lives in an HttpOnly cookie
 * the server reads itself, so nothing here is needed for attribution.
 */
export interface FunnelState {
  answers: Answers;
  /** Fields that came from the affiliate link and haven't been edited (UI hint only; the server computes the real provenance). */
  prefilled: AnswerKey[];
  /** Nonce of the last prefill applied. A new affiliate click = new nonce = fresh journey. */
  prepopNonce: string | null;
  /** One per journey. Reused on every submit attempt so double-clicks / retries can't create two leads. */
  idempotencyKey: string;
}

const STORAGE_KEY = "ql_funnel_v1";

const fresh = (): FunnelState => ({ answers: {}, prefilled: [], prepopNonce: null, idempotencyKey: crypto.randomUUID() });

let state: FunnelState | null = null;
const listeners = new Set<() => void>();

function load(): FunnelState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FunnelState>;
      if (parsed && typeof parsed.idempotencyKey === "string" && parsed.answers && typeof parsed.answers === "object") {
        return {
          answers: parsed.answers,
          prefilled: Array.isArray(parsed.prefilled) ? parsed.prefilled : [],
          prepopNonce: typeof parsed.prepopNonce === "string" ? parsed.prepopNonce : null,
          idempotencyKey: parsed.idempotencyKey,
        };
      }
    }
  } catch {
    // Storage blocked (private mode, quota) — the funnel still works, just without refresh survival.
  }
  return fresh();
}

function commit(next: FunnelState) {
  state = next;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* see load() */
  }
  for (const l of listeners) l();
}

function get(): FunnelState {
  if (!state) state = load();
  return state;
}

export const funnelStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get,

  /** Apply a prefill once per nonce. Refreshes don't re-apply it over the visitor's edits. */
  applyPrepop(env: { nonce: string; values: Prepop } | null) {
    if (!env || env.nonce === get().prepopNonce) return;
    const keys = PREPOP_KEYS.filter((k) => env.values[k] !== undefined);
    commit({ ...fresh(), answers: { ...env.values }, prefilled: keys, prepopNonce: env.nonce });
  },

  setAnswers(patch: Partial<Answers>) {
    const s = get();
    const changed = (Object.keys(patch) as AnswerKey[]).filter((k) => patch[k] !== s.answers[k]);
    if (!changed.length) return;
    commit({
      ...s,
      answers: { ...s.answers, ...patch },
      prefilled: s.prefilled.filter((k) => !changed.includes(k)),
    });
  },

  reset() {
    commit(fresh());
  },
};

/** `null` during SSR / before hydration, so pages render a stable skeleton instead of a flash of wrong state. */
export function useFunnelState(): FunnelState | null {
  return useSyncExternalStore(funnelStore.subscribe, funnelStore.get, () => null);
}
