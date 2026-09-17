/**
 * The API, reached on the page's own origin.
 *
 * The session is the cookie the browser holds, which page script cannot read
 * (ADR-0004). Nothing here asks for, reads or stores a token: the browser sends
 * the cookie with every same-origin request by itself, and an `Origin` with
 * every change, which is what the server checks the cookie against.
 */

export type ApiResult<T> = { ok: true; body: T } | { ok: false };

/**
 * Sends a request and says only whether it was answered. A refusal, a throttled
 * request, a server error and a network failure are all `ok: false`: the app
 * has one state for all of them, and never explains a refusal the API
 * deliberately did not explain (ADR-0002).
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      return { ok: false };
    }
    return { ok: true, body: (response.status === 204 ? undefined : await response.json()) as T };
  } catch {
    return { ok: false };
  }
}

export interface School {
  id: string;
  name: string;
}

export const api = {
  signIn: (credentials: { username: string; password: string }) =>
    request<{ expiresAt: string }>("POST", "/session", credentials),
  session: () => request<{ account: { id: string; username: string } }>("GET", "/session"),
  signOut: () => request<undefined>("DELETE", "/session"),
  schools: () => request<{ schools: School[] }>("GET", "/schools"),
};
