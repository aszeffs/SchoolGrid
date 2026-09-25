import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isRole } from "../access/roles.ts";
import { recordAuthenticationAttempt } from "../audit/index.ts";
import { fromPublicOrigin, startBrowserSession, type Authenticator } from "../authentication/index.ts";
import { isKnownTimezone } from "../calendar/index.ts";
import type { PublicOrigin, TrialSettings } from "../config.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction, type Queryable } from "../db/transaction.ts";
import { refuse } from "../http/refusal.ts";
import { deleteExpiredTrialSchools, roleAccountFor, startTrialSchool } from "./index.ts";

/**
 * The body served when no trial can be started right now: this deployment
 * holds as many live Trial Schools as it may, or this client has started as
 * many as it may this hour. Not a refusal in the ADR-0002 sense, since it
 * reveals nothing about any record, and kept distinct so the page can say
 * plainly to try again later.
 */
const BUSY = { status: "busy" } as const;

const HOUR_MS = 60 * 60 * 1000;

/**
 * One field of a body, or undefined for a body that is no object. Read leniently:
 * a start never fails on its body, and a malformed change of role is refused
 * like any other.
 */
function fieldOf(body: unknown, field: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[field] : undefined;
}

/** The timezone a trial was asked for, when the database knows it, or UTC: starting one never fails on it. */
async function timezoneOrUtc(database: Queryable, body: unknown): Promise<string> {
  const timezone = fieldOf(body, "timezone");
  return typeof timezone === "string" && timezone.length <= 64 && (await isKnownTimezone(database, timezone))
    ? timezone
    : "UTC";
}

function refused(request: FastifyRequest, reply: FastifyReply, reason: string): FastifyReply {
  request.log.info({ reason, url: request.url }, "refused");
  return refuse(reply);
}

/**
 * Starting a Trial School, and changing role within one (ADR-0012). Neither is
 * School-scoped: a visitor starting one is in no School yet, and one changing
 * role is known by the Session the trial issued them.
 *
 * Registered whatever the settings, so every server has the same routes. With
 * trials off, as everywhere but the public showcase, both refuse.
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
  // Counted in the same process memory as the server-wide limit, and keyed on
  // the same client address.
  const startsThisHour = api.createRateLimit({ max: settings.perClientPerHour, timeWindow: HOUR_MS });

  api.post("/trials", async (request, reply) => {
    if (!settings.enabled) {
      return refused(request, reply, "trials-disabled");
    }
    // It answers with a browser Session, which a page on another site must not
    // be able to plant, exactly as a sign-in from one may not (ADR-0004).
    if (!fromPublicOrigin(request, publicOrigin)) {
      return refused(request, reply, "cross-origin");
    }
    const limit = await startsThisHour(request);
    if (!limit.isAllowed && limit.isExceeded) {
      request.log.info("busy: this client has started as many trials as it may this hour");
      return reply.status(429).header("retry-after", String(limit.ttlInSeconds)).send(BUSY);
    }

    const timezone = await timezoneOrUtc(database, request.body);
    // Expired trials go first, so the ones they held count no longer.
    await deleteExpiredTrialSchools(database);
    const started = await withTransaction(database, async (transaction) => {
      const trial = await startTrialSchool(transaction, { timezone, liveCap: settings.liveCap });
      return trial === null ? null : { trial, session: await startBrowserSession(transaction, trial.schoolAdministrator) };
    });
    if (started === null) {
      request.log.info("busy: as many Trial Schools are live as may be");
      return reply.status(503).send(BUSY);
    }

    // Starting over drops the Session the browser held before, if it held one.
    await authenticator.endSession(request);
    const { trial, session } = started;
    return reply
      .status(201)
      .header("set-cookie", session.cookie)
      .send({
        expiresAt: session.expiresAt,
        trial: { schoolId: trial.school.id, expiresAt: trial.expiresAt.toISOString() },
      });
  });

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
