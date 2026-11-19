import { revalidatePrepop, type Prepop } from "@/domain/prepop";
import { MAX_AGE } from "@/domain/cookies";
import { PURPOSE, seal, unseal } from "./crypto/seal";

/** What's inside the sealed ql_pp cookie. */
export interface PrepopEnvelope {
  /** Changes on every new affiliate arrival; the client applies a prefill once per nonce. */
  nonce: string;
  values: Prepop;
}

export function sealPrepop(env: PrepopEnvelope, secret: string): Promise<string> {
  return seal(env, secret, PURPOSE.prepop, MAX_AGE.prepop);
}

export async function unsealPrepop(token: string | undefined, secret: string | null): Promise<PrepopEnvelope | null> {
  if (!token || !secret) return null;
  const raw = await unseal<{ nonce?: unknown; values?: unknown }>(token, secret, PURPOSE.prepop);
  if (!raw || typeof raw.nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(raw.nonce)) return null;
  return { nonce: raw.nonce, values: revalidatePrepop(raw.values) };
}
