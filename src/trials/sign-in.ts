import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { TrialProvider, TrialProviderSettings } from "../config.ts";

/**
 * A Trial visitor proving an outside identity (ADR-0013): the OAuth
 * authorization code flow, with state and PKCE, against one provider. It ends
 * in the provider's subject identifier and nothing else. The provider's token
 * is used once to read it and is never kept, and no name or email is asked for.
 *
 * It decides nothing about trials. What the identity is for is the Trials
 * module's.
 *
 * What the flow must remember between sending the visitor off and their
 * return, the state and the PKCE verifier, travels in a short-lived cookie
 * signed with the identity key. The visitor's browser holds it, so no row is
 * written for a sign-in that is never finished.
 */

/** How each provider is asked, and where its answer names the subject. */
const PROVIDERS: Record<TrialProvider, { scope: string | null; subjectOf: (user: Record<string, unknown>) => unknown }> = {
  // No scope reads only what is public. The numeric id, unlike the login,
  // outlives a change of username.
  github: { scope: null, subjectOf: (user) => user["id"] },
};

/** Where every provider sends the visitor back, each under its own name: `/api/trials/callback/github`. */
export const CALLBACK_PATH = "/api/trials/callback";

/** How long a visitor has at the provider before their sign-in lapses. */
const FLOW_LIFETIME_S = 10 * 60;

/**
 * The cookie the flow is remembered in. `__Secure-` makes a browser keep it
 * only when `Secure`. Scoped to the callback, the one request that reads it,
 * and `SameSite=Lax` so it is sent on the provider's redirect back, a
 * cross-site navigation.
 */
const FLOW_COOKIE = "__Secure-trial-sign-in";
const FLOW_COOKIE_ATTRIBUTES = `Path=${CALLBACK_PATH}; Secure; HttpOnly; SameSite=Lax`;

/** Replaces the flow cookie with one the browser discards at once. */
export const EXPIRED_FLOW_COOKIE = `${FLOW_COOKIE}=; ${FLOW_COOKIE_ATTRIBUTES}; Max-Age=0`;

/** What a sign-in in progress remembers. `timezone` is the visitor's, for the School it starts. */
interface Flow {
  provider: TrialProvider;
  state: string;
  verifier: string;
  timezone: string;
  expiresAt: number;
}

/** Keys derived from the one identity key, one per use, so a signature made for one can never pass for the other. */
function keyFor(identityKey: string, purpose: "identity" | "flow"): Buffer {
  return createHmac("sha256", identityKey).update(`schoolgrid-trial-${purpose}`).digest();
}

/**
 * What is kept of a Trial visitor: a keyed hash of the provider and its
 * subject. It finds the same visitor again, and says nothing to anyone
 * without the key about who they are.
 */
export function visitorIdentity(identityKey: string, provider: TrialProvider, subject: string): Buffer {
  return createHmac("sha256", keyFor(identityKey, "identity")).update(`${provider}:${subject}`).digest();
}

function sign(identityKey: string, payload: string): string {
  return createHmac("sha256", keyFor(identityKey, "flow")).update(payload).digest("base64url");
}

function random(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Starts a sign-in: where to send the visitor, and the cookie remembering the
 * flow until they are back.
 */
export function beginSignIn({
  provider,
  settings,
  identityKey,
  redirectUri,
  timezone,
  now = Date.now(),
}: {
  provider: TrialProvider;
  settings: TrialProviderSettings;
  identityKey: string;
  redirectUri: string;
  timezone: string;
  now?: number;
}): { location: string; cookie: string } {
  const flow: Flow = { provider, state: random(), verifier: random(), timezone, expiresAt: now + FLOW_LIFETIME_S * 1000 };
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");

  const location = new URL(settings.authorizeUrl);
  const { scope } = PROVIDERS[provider];
  location.searchParams.set("response_type", "code");
  location.searchParams.set("client_id", settings.clientId);
  location.searchParams.set("redirect_uri", redirectUri);
  location.searchParams.set("state", flow.state);
  location.searchParams.set("code_challenge", createHash("sha256").update(flow.verifier).digest("base64url"));
  location.searchParams.set("code_challenge_method", "S256");
  if (scope !== null) {
    location.searchParams.set("scope", scope);
  }
  return {
    location: location.href,
    cookie: `${FLOW_COOKIE}=${payload}.${sign(identityKey, payload)}; ${FLOW_COOKIE_ATTRIBUTES}; Max-Age=${FLOW_LIFETIME_S}`,
  };
}

/** The flow this cookie header remembers, when it carries exactly one flow cookie, signed and unexpired, for this provider. */
function flowOf(cookieHeader: string | undefined, identityKey: string, provider: TrialProvider, now: number): Flow | null {
  const values = (cookieHeader ?? "").split(";").flatMap((pair) => {
    const separator = pair.indexOf("=");
    return separator !== -1 && pair.slice(0, separator).trim() === FLOW_COOKIE ? [pair.slice(separator + 1).trim()] : [];
  });
  if (values.length !== 1) {
    return null;
  }
  const [payload, signature, ...rest] = values[0]!.split(".");
  if (payload === undefined || signature === undefined || rest.length > 0) {
    return null;
  }
  const expected = Buffer.from(sign(identityKey, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  const flow = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Flow;
  return flow.provider === provider && flow.expiresAt > now ? flow : null;
}

/** How a sign-in ended. Why one failed is for the log, never the visitor. */
export type SignInOutcome =
  | { status: "signed-in"; subject: string; timezone: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

/**
 * Finishes a sign-in from the provider's redirect back: checks it against the
 * flow its cookie remembers, trades the code and verifier for a token, and
 * reads the subject with it.
 */
export async function completeSignIn({
  provider,
  settings,
  identityKey,
  redirectUri,
  query,
  cookieHeader,
  now = Date.now(),
}: {
  provider: TrialProvider;
  settings: TrialProviderSettings;
  identityKey: string;
  redirectUri: string;
  query: Record<string, unknown>;
  cookieHeader: string | undefined;
  now?: number;
}): Promise<SignInOutcome> {
  const flow = flowOf(cookieHeader, identityKey, provider, now);
  if (flow === null) {
    return { status: "failed", reason: "no-flow" };
  }
  // The state binds the redirect to the browser that began the sign-in, so
  // no one can finish theirs in another's (RFC 6749, section 10.12).
  const state = query["state"];
  if (typeof state !== "string" || !equal(state, flow.state)) {
    return { status: "failed", reason: "state-mismatch" };
  }
  if (query["error"] === "access_denied") {
    return { status: "cancelled" };
  }
  const code = query["code"];
  if (typeof code !== "string" || code === "") {
    return { status: "failed", reason: "no-code" };
  }

  const token = await accessTokenFor(settings, { code, verifier: flow.verifier, redirectUri });
  if (token === null) {
    return { status: "failed", reason: "token-refused" };
  }
  const subject = await subjectFor(provider, settings, token);
  if (subject === null) {
    return { status: "failed", reason: "no-subject" };
  }
  return { status: "signed-in", subject, timezone: flow.timezone };
}

function equal(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** How long each call to a provider may take before the sign-in is failed. */
const PROVIDER_TIMEOUT_MS = 10_000;

async function accessTokenFor(
  settings: TrialProviderSettings,
  { code, verifier, redirectUri }: { code: string; verifier: string; redirectUri: string },
): Promise<string | null> {
  const body = await jsonFrom(settings.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code_verifier: verifier,
    }).toString(),
  });
  const token = body?.["access_token"];
  return typeof token === "string" && token !== "" ? token : null;
}

async function subjectFor(provider: TrialProvider, settings: TrialProviderSettings, token: string): Promise<string | null> {
  const user = await jsonFrom(settings.userUrl, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      // GitHub's API refuses a request without one.
      "user-agent": "SchoolGrid",
    },
  });
  const subject = user === null ? undefined : PROVIDERS[provider].subjectOf(user);
  if (typeof subject === "number" && Number.isSafeInteger(subject)) {
    return String(subject);
  }
  return typeof subject === "string" && subject !== "" && subject.length <= 255 ? subject : null;
}

/** A provider's JSON object answer to a successful request, or null for any other. */
async function jsonFrom(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
