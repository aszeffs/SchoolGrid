import { api } from "./api.ts";
import { navigate } from "./navigation.ts";

/**
 * What a page does when a request of its own was not answered, and what it
 * shows afterwards.
 *
 * There are two outcomes and no third. A session that has ended sends the user
 * to sign in, because every page behind it would fail the same way; this
 * navigates there itself, and the caller has nothing left to show. Everything
 * else — refused, throttled, a server error, a network failure — is the one
 * "not available" state, worded identically wherever it appears (ADR-0002).
 *
 * Nothing here learns which of those it was, and nothing downstream may say.
 * A page that distinguished "you may not read this" from "this does not exist"
 * would tell a caller what the API deliberately did not. Do not add a reason.
 */
export async function afterFailure(): Promise<"not-available" | "signed-out"> {
  if ((await api.session()).ok) {
    return "not-available";
  }
  navigate({ name: "signIn" }, { replace: true });
  return "signed-out";
}
