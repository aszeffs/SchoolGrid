import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveActor, Refused, type Actor, type RefusalReason } from "../access/index.ts";
import { recordRefusal } from "../audit/index.ts";
import { accountForRequest, type UserAccount } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { refuse } from "./refusal.ts";

export interface SchoolScopedRequest {
  params: Readonly<Record<string, string>>;
  /**
   * The body as sent, or undefined when there was none or it was not JSON. Not
   * yet validated: validate it after the Access decision, never before.
   */
  body: unknown;
}

export type SchoolScopedHandler = (actor: Actor, request: SchoolScopedRequest) => Promise<unknown>;

/**
 * Registers routes addressed within a School, under `/schools/:schoolId`. A
 * `post` answers 201, since it creates; every other method answers 200.
 */
export interface SchoolScope {
  get(path: string, handler: SchoolScopedHandler): void;
  post(path: string, handler: SchoolScopedHandler): void;
  patch(path: string, handler: SchoolScopedHandler): void;
  delete(path: string, handler: SchoolScopedHandler): void;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/**
 * The boundary every School-scoped request passes through.
 *
 * It resolves the caller to an Actor once, before the handler runs, and hands
 * the handler that Actor instead of the request: a handler never reads the raw
 * session and never holds the reply, so it can neither skip resolution nor
 * send a refusal of its own. It answers with a value, or it throws `Refused`.
 *
 * A request that is answered is not audited. Successful routine reads are left
 * out of the trail on purpose, not by oversight: against a quiet background, a
 * run of refusals is what stands out, and that is how probing is seen. Do not
 * add them. A handler that changes something records its own Audit record, in
 * the same transaction as the change.
 */
export function registerSchoolScope(
  app: FastifyInstance,
  database: Database,
  routes: (scope: SchoolScope) => void,
): void {
  const route = (method: Method, path: string, handler: SchoolScopedHandler) => {
    app.route({
      method,
      url: `/schools/:schoolId${path}`,
      handler: async (request, reply) => {
        const params = request.params as Record<string, string>;
        const schoolId = params["schoolId"]!;
        const account = await accountForRequest(database, request);
        let actor: Actor | null = null;
        try {
          actor = await resolveActor(database, account, schoolId);
          const answer = await handler(actor, { params, body: request.body });
          return reply.status(method === "POST" ? 201 : 200).send(answer);
        } catch (error) {
          if (!(error instanceof Refused)) {
            throw error;
          }
          return refuseInSchool(database, request, reply, { schoolId, account, actor, refused: error });
        }
      },
    });
  };

  routes({
    get: (path, handler) => route("GET", path, handler),
    post: (path, handler) => route("POST", path, handler),
    patch: (path, handler) => route("PATCH", path, handler),
    delete: (path, handler) => route("DELETE", path, handler),
  });
}

/**
 * Refuses a request that no route handled. Under `/schools/:schoolId` it is a
 * refusal in that School like any other, so it is recorded like any other.
 * Anything outside a School is refused without a record: there is no trail to
 * hold it.
 */
export async function refuseUnrouted(
  database: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  reason: Extract<RefusalReason, "no-such-route" | "malformed-url">,
): Promise<FastifyReply> {
  const schoolId = /^\/schools\/([^/?#]+)/.exec(request.url)?.[1];
  if (schoolId === undefined) {
    request.log.info({ reason, url: request.url }, "refused");
    return refuse(reply);
  }
  const account = await accountForRequest(database, request);
  let actor: Actor | null = null;
  try {
    actor = await resolveActor(database, account, schoolId);
    throw new Refused(reason);
  } catch (error) {
    if (!(error instanceof Refused)) {
      throw error;
    }
    return refuseInSchool(database, request, reply, { schoolId, account, actor, refused: error });
  }
}

/**
 * This is the School-scoped refusal chokepoint, and it deliberately tells the
 * caller nothing. An absent record, a record in another School, a forbidden
 * record, and a caller with no Person here all leave with the identical
 * response (ADR-0002). The true reason goes to the addressed School's Audit
 * record and to the log, and nowhere else. Do not add it to the response to
 * make errors friendlier: any difference lets a caller confirm that a record
 * exists.
 */
async function refuseInSchool(
  database: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  {
    schoolId,
    account,
    actor,
    refused,
  }: { schoolId: string; account: UserAccount | null; actor: Actor | null; refused: Refused },
): Promise<FastifyReply> {
  request.log.info({ reason: refused.reason, url: request.url }, "refused");
  const caller = refused.caller;
  // A Person who could not become an Actor, because no membership of theirs
  // is in force, is still a Person this School knows, and is named as one.
  const person = actor?.person ?? (caller !== undefined && "person" in caller ? caller.person : null);
  // A Platform Administrator is named as one, so the School sees what was
  // attempted against it from outside.
  const platformAdministrator =
    caller !== undefined && "platformAdministrator" in caller ? caller.platformAdministrator : null;
  await recordRefusal(database, {
    schoolId,
    actorPersonId: person?.id ?? null,
    actorPlatformAdministratorId: platformAdministrator?.id ?? null,
    // An account that reached no Person here is named only by its opaque
    // identifier, so repeated probes can be linked without the School learning
    // who holds it.
    userAccountId: person === null && platformAdministrator === null ? (account?.id ?? null) : null,
    reason: refused.reason,
    // Without a target of its own, the request is what was refused: named by
    // path alone, since a query string is the caller's to fill with anything.
    target: refused.target ?? { type: "request", id: `${request.method} ${request.url.split("?")[0]}` },
  });
  return refuse(reply);
}
