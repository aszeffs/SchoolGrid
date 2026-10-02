import { useEffect, useState } from "react";
import type { TrialProvider } from "../../src/config.ts";
import { api } from "./api.ts";

/**
 * What the browser keeps about the Trial School it is in: when that School
 * expires, and nothing else. A Session in an expired trial is refused like any
 * other that is not live, so this is how the app, told only that, can still say
 * the trial ended rather than send its visitor to sign in (ADR-0012).
 *
 * Browser storage can be missing or refuse a write; without it the app loses
 * only that one sentence, and sends the visitor to sign in instead.
 */
const REMEMBERED = "schoolgrid:trial-expires-at";

/** Remembers when the trial this browser is in expires, or that it is in none. */
export function rememberTrial(expiresAt: string | null): void {
  try {
    if (expiresAt === null) {
      localStorage.removeItem(REMEMBERED);
    } else {
      localStorage.setItem(REMEMBERED, expiresAt);
    }
  } catch {
    // Nothing remembered, so nothing to say later.
  }
}

/** Whether the trial this browser was last in has expired. */
export function trialHasEnded(): boolean {
  try {
    const expiresAt = localStorage.getItem(REMEMBERED);
    return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
  } catch {
    return false;
  }
}

/** How long a trial has left, as `1h 52m`, counting a part-minute as a whole one until it is gone. */
export function timeLeft(expiresAt: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 60_000));
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The clock, read again every second, for a count that must reach zero on time. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return now;
}

/**
 * The providers a visitor can sign in with to start a Trial School, none
 * until the server has said, and none if it cannot be asked: a button that
 * could only fail would be worse than none (ADR-0013).
 */
export function useTrialProviders(): readonly TrialProvider[] {
  const [providers, setProviders] = useState<readonly TrialProvider[]>([]);
  useEffect(() => {
    let current = true;
    void api.trials().then((trials) => {
      if (current && trials.ok && trials.body.enabled) {
        setProviders(trials.body.providers);
      }
    });
    return () => {
      current = false;
    };
  }, []);
  return providers;
}

/** Why a sign-in started no trial, as the server sends the visitor back to say: `/?trial=busy`. */
export type StartFailure = "busy" | "cancelled" | "failed";

const START_FAILURES: readonly StartFailure[] = ["busy", "cancelled", "failed"];

/**
 * Why the sign-in this page was sent back from started no trial, if it was,
 * taken off the address once read, so a reload or a shared link does not say
 * it again.
 */
export function takeStartFailure(): StartFailure | null {
  const url = new URL(window.location.href);
  const why = url.searchParams.get("trial");
  if (why === null) {
    return null;
  }
  url.searchParams.delete("trial");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return START_FAILURES.find((failure) => failure === why) ?? null;
}

/** What a visitor is told when a trial could not be started. */
export const START_FAILED: Record<StartFailure, string> = {
  busy: "SchoolGrid is busy right now. Try again in a little while.",
  cancelled: "Sign-in was cancelled, so no trial was started.",
  failed: "A new trial could not be started. Try again.",
};

/** Each provider as its button names it. */
export const PROVIDER_NAMES: Record<TrialProvider, string> = { github: "GitHub", google: "Google" };

/** Where a sign-in with this provider starts. */
export function startPath(provider: TrialProvider): string {
  return `/api/trials/start/${provider}`;
}
