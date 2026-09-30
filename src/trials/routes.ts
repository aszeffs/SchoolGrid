import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isRole } from "../access/roles.ts";
import { recordAuthenticationAttempt } from "../audit/index.ts";
import { startBrowserSession, type Authenticator } from "../authentication/index.ts";
import { isKnownTimezone } from "../calendar/index.ts";
import {
  TRIAL_PROVIDERS,
  type PublicOrigin,
  type TrialProvider,
  type TrialProviderSettings,
  type TrialSettings,
} from "../config.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { refuse } from "../http/refusal.ts";
import { deleteExpiredTrialSchools, roleAccountFor, startTrialSchool } from "./index.ts";
import { beginSignIn, CALLBACK_PATH, completeSignIn, EXPIRED_FLOW_COOKIE, visitorIdentity } from "./sign-in.ts";

/**
 * Where a sign-in that started no trial sends the visitor back: the front
 * page, told why in one word it turns into a sentence. Busy is when this
 * deployment holds as many live Trial Schools as it may; cancelled when the
 * visitor turned the provider down; failed for anything else, whose reason is
 * logged and never shown. None is a refusal in the ADR-0002 sense, since none
 * reveals anything about any record.
 */
type Unstarted = "busy" | "cancelled" | "failed";

function backToLanding(reply: FastifyReply, why: Unstarted): FastifyReply {
  return reply.status(303).header("set-cookie", EXPIRED_FLOW_COOKIE).header("location", `/?trial=${why}`).send();
}

/**
 * One field of an object, or undefined for anything that is no object. Read
 * leniently: a malformed change of role is refused like any other.
 */
function fieldOf(body: unknown, field: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

/** The longest timezone name carried through a sign-in: longer than any the database knows. */
const MAX_TIMEZONE_LENGTH = 64;

/** The timezone a trial was asked for, when the database knows it, or UTC: starting one never fails on it. */
async function timezoneOrUtc(database: Queryable, timezone: string): Promise<string> {
  return timezone !== "" && (await isKnownTimezone(database, timezone)) ? timezone : "UTC";
}

/** The provider a path names, when it is one this deployment offers, with its settings. */
function offeredProvider(
  settings: TrialSettings,
  name: unknown,
): { provider: TrialProvider; settings: TrialProviderSettings } | null {
  const provider = TRIAL_PROVIDERS.find((candidate) => candidate === name);
  const offered = provider === undefined ? undefined : settings.providers[provider];
  return provider === undefined || offered === undefined ? null : { provider, settings: offered };
}

function refused(request: FastifyRequest, reply: FastifyReply, reason: string): FastifyReply {
  request.log.info({ reason, url: request.url }, "refused");
  return refuse(reply);
}

/**
 * Starting a Trial School by signing in with an outside identity, and
 * changing role within one (ADR-0012, ADR-0013). None is School-scoped: a
 * visitor starting one is in no School yet, and one changing role is known by
 * the Session the trial issued them.
 *
 * Registered whatever the settings, so every server has the same routes. With
 * trials off, as everywhere but the public showcase, all refuse. Whether
 * trials are on, and with which providers, is itself public, answered to
 * anyone, for the front page.
 */
export function registerTrialRoutes(
  api: FastifyInstance,
  {
    database,
    authenticator,
    publicOrigin,
    settings,
  }: { database: Database; authenticator: Authenticator; publicOrigin: PublicOrigin; settings: TrialSettings },
): void {
  // Whether to offer a trial at all, and through which providers, for the
  // landing page. Public, and the same answer to everyone: it says nothing
  // about any School.
  const offered = {
    enabled: settings.enabled,
    providers: settings.enabled ? TRIAL_PROVIDERS.filter((provider) => settings.providers[provider] !== undefined) : [],
  };
  api.get("/trials", async (_request, reply) => reply.status(200).send(offered));

  const redirectUriFor = (provider: TrialProvider) => `${publicOrigin}${CALLBACK_PATH}/${provider}`;

  // A top-level navigation, not a fetch: the visitor leaves for the provider,
  // carrying the timezone their School should keep.
  api.get<{ Params: { provider: string }; Querystring: { timezone?: unknown } }>(
    "/trials/start/:provider",
    async (request, reply) => {
      const chosen = settings.enabled ? offeredProvider(settings, request.params.provider) : null;
      if (chosen === null) {
        return refused(request, reply, settings.enabled ? "unoffered-provider" : "trials-disabled");
      }
      const { timezone } = request.query;
      const { location, cookie } = beginSignIn({
        ...chosen,
        identityKey: settings.identityKey,
        redirectUri: redirectUriFor(chosen.provider),
        timezone: typeof timezone === "string" && timezone.length <= MAX_TIMEZONE_LENGTH ? timezone : "",
      });
      return reply.status(303).header("set-cookie", cookie).header("location", location).send();
    },
  );

  // The provider's redirect back. Only a sign-in this browser began, checked
  // by its state, starts anything, so no other site can start a trial in the
  // visitor's browser or plant its Session there.
  api.get<{ Params: { provider: string }; Querystring: Record<string, unknown> }>(
    `/trials/callback/:provider`,
    async (request, reply) => {
      const chosen = settings.enabled ? offeredProvider(settings, request.params.provider) : null;
      if (chosen === null) {
        return refused(request, reply, settings.enabled ? "unoffered-provider" : "trials-disabled");
      }
      const outcome = await completeSignIn({
        ...chosen,
        identityKey: settings.identityKey,
        redirectUri: redirectUriFor(chosen.provider),
        query: request.query,
        cookieHeader: request.headers.cookie,
      });
      if (outcome.status !== "signed-in") {
        request.log.info({ outcome }, "trial sign-in started no trial");
        return backToLanding(reply, outcome.status);
      }

      const timezone = await timezoneOrUtc(database, outcome.timezone);
      const visitor = visitorIdentity(settings.identityKey, chosen.provider, outcome.subject);
      // Expired trials go first, so the ones they held count no longer.
      await deleteExpiredTrialSchools(database);
      const started = await withTransaction(database, async (transaction) => {
        const trial = await startTrialSchool(transaction, { timezone, liveCap: settings.liveCap, visitor });
        return trial === null ? null : { trial, session: await startBrowserSession(transaction, trial.schoolAdministrator) };
      });
      if (started === null) {
        request.log.info("busy: as many Trial Schools are live as may be");
        return backToLanding(reply, "busy");
      }

      // Starting over drops the Session the browser held before, if it held one.
      await authenticator.endSession(request);
      return reply
        .status(303)
        .header("set-cookie", [EXPIRED_FLOW_COOKIE, started.session.cookie])
        .header("location", `/schools/${started.trial.school.id}/persons`)
        .send();
    },
  );

  api.post("/trials/role", async (request, reply) => {
    if (!settings.enabled) {
      return refused(request, reply, "trials-disabled");
    }
    // Covers the Origin check on a cookie session: authenticate reports a
    // cross-origin change before it looks the Session up.
    const { account, failure } = await authenticator.authenticate(request);
    if (account === null) {
      return refused(request, reply, failure);
    }
    const role = fieldOf(request.body, "role");
    if (!isRole(role)) {
      return refused(request, reply, "malformed-role");
    }
    const target = await roleAccountFor(database, { account, role });
    if (target === null) {
      return refused(request, reply, "outside-trial-school");
    }

    const session = await withTransaction(database, async (transaction) => {
      const replaced = await authenticator.replaceSession(transaction, request, target);
      // Recorded as the School's trail records a sign-in, against the Person
      // the role account resolves to.
      if (replaced !== null) {
        await recordAuthenticationAttempt(transaction, { userAccountId: target.id, succeeded: true });
      }
      return replaced;
    });
    if (session === null) {
      return refused(request, reply, "unauthenticated");
    }
    return reply.status(201).header("set-cookie", session.cookie).send({ expiresAt: session.expiresAt });
  });
}
