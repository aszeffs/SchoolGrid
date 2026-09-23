import { useEffect, useRef, useState } from "react";
import { api, type ApiResult } from "./api.ts";
import { navigate } from "./navigation.ts";

/** What a screen is showing: still printing, the one refusal state, or its records. */
export type Showing<T> = { kind: "loading" } | { kind: "not-available" } | { kind: "ready"; records: T };

export interface Screen<T> {
  showing: Showing<T>;
  /** Whether a change this screen sent is still in flight, so controls can be held. */
  busy: boolean;
  /**
   * Sends a change, lists the screen's records again, and returns what the
   * change itself answered — so a caller can act on the one response that
   * carries something the server will never say twice.
   */
  change: <R>(send: () => Promise<ApiResult<R>>) => Promise<ApiResult<R>>;
}

/**
 * One screen's records, read from the server and read again after every change.
 *
 * Every screen within a School has the same three states and the same two ways
 * of failing, and this is the one place either is decided. `list` is a function
 * of `api`, passed rather than called here, so a screen says which records are
 * its own and nothing else.
 *
 * Nothing is ever applied to a screen before the server has confirmed it. A
 * refusal the actor cannot see is indistinguishable from a success, so an
 * optimistic update could show a change that never happened (ADR-0002).
 */
export function useScreen<T>(schoolId: string, list: (schoolId: string) => Promise<ApiResult<T>>): Screen<T> {
  const [showing, setShowing] = useState<Showing<T>>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  /*
   * Whether this screen is still the one being shown. It outlives each render,
   * so a request still in flight when the actor moves on can be dropped rather
   * than setting state on a screen that has gone.
   */
  const open = useRef(true);

  /**
   * Shows what a request answered, or the one state for anything it did not.
   *
   * There are two ways of failing and no third. A session that has ended sends
   * the actor to sign in, because every page behind it would fail the same way.
   * Everything else — refused, throttled, a server error, a network failure —
   * is the one "not available" state, worded identically wherever it appears
   * (ADR-0002). Which of those it was is never learnt here, and must never be
   * said: a screen that distinguished "you may not read this" from "this does
   * not exist" would tell a caller what the API deliberately did not.
   */
  const settle = async (answered: ApiResult<T>): Promise<void> => {
    if (answered.ok) {
      if (open.current) {
        setShowing({ kind: "ready", records: answered.body });
      }
      return;
    }
    const live = (await api.session()).ok;
    if (!open.current) {
      return;
    }
    if (live) {
      setShowing({ kind: "not-available" });
    } else {
      navigate({ name: "signIn" }, { replace: true });
    }
  };

  useEffect(() => {
    open.current = true;
    void (async () => {
      await settle(await list(schoolId));
    })();
    return () => {
      open.current = false;
    };
  }, [schoolId, list]);

  const change = async <R,>(send: () => Promise<ApiResult<R>>): Promise<ApiResult<R>> => {
    setBusy(true);
    const sent = await send();
    // Listed again whatever the change answered, so what is shown is what the
    // server holds. A change that was made but could not be listed afterwards
    // is not shown as though it had not been: the screen goes to the one
    // not-available state, and anything the response carried that cannot be
    // asked for twice is held outside the screen's own state.
    const listed: ApiResult<T> = sent.ok ? await list(schoolId) : { ok: false };
    if (open.current) {
      setBusy(false);
    }
    await settle(listed);
    return sent;
  };

  return { showing, busy, change };
}
