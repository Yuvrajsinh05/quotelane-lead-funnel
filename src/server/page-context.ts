import "server-only";
import { cookies } from "next/headers";
import { COOKIE } from "@/domain/cookies";
import { getAppSecretOrNull } from "./config";
import { unsealPrepop, type PrepopEnvelope } from "./prepop-cookie";

/**
 * Server-side read of the sealed prepop cookie for rendering. The values go to the
 * client as props so the form can show them (editable); the cookie itself stays
 * HttpOnly so no client script (or third-party tag) can ever read it.
 */
export async function readPrepopForPage(): Promise<PrepopEnvelope | null> {
  const jar = await cookies();
  return unsealPrepop(jar.get(COOKIE.prepop)?.value, getAppSecretOrNull());
}
