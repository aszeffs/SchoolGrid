import { useEffect, useState } from "react";
import { api, type StartedTrial } from "./api.ts";

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

/** Why a trial could not be started: busy is said as busy, and anything else the one way. */
export type StartFailure = "busy" | "failed";

/**
 * Starting a Trial School from a button, in the browser's own timezone so its
 * dates look right to the visitor. The server falls back to UTC for one it
 * does not know. `onStarted` is given the new School once its Session is the
 * browser's.
 */
export function useStartTrial(onStarted: (trial: StartedTrial) => void): {
  start: () => Promise<void>;
  starting: boolean;
  failure: StartFailure | null;
} {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const start = async () => {
    setStarting(true);
    setFailure(null);
    const started = await api.startTrial(Intl.DateTimeFormat().resolvedOptions().timeZone);
    setStarting(false);
    if (started.status === "started") {
      rememberTrial(started.trial.expiresAt);
      onStarted(started.trial);
    } else {
      setFailure(started.status === "busy" ? "busy" : "failed");
    }
  };
  return { start, starting, failure };
}

/** What a visitor is told when a trial could not be started. */
export const START_FAILED: Record<StartFailure, string> = {
  busy: "SchoolGrid is busy right now. Try again in a little while.",
  failed: "A new trial could not be started. Try again.",
};
