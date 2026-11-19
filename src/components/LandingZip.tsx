"use client";

import { useRouter } from "next/navigation";
import { useLayoutEffect } from "react";
import type { Prepop } from "@/domain/prepop";
import { funnelStore, useFunnelState } from "./funnel/store";
import { ZipStep } from "./funnel/steps";

export function LandingZip({ prepop }: { prepop: { nonce: string; values: Prepop } | null }) {
  const state = useFunnelState();
  const router = useRouter();
  useLayoutEffect(() => funnelStore.applyPrepop(prepop), [prepop]);

  return (
    <ZipStep
      // Remount once client state is available so a ZIP from earlier in the session shows up.
      key={state ? "client" : "server"}
      answers={state?.answers ?? {}}
      prefilled={false}
      cta="Get My Free Quotes"
      onAnswer={(patch) => {
        funnelStore.setAnswers(patch);
        router.push("/quote");
      }}
    />
  );
}
