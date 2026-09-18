import type { RouteHandlerMethod } from "fastify";
import type { Authenticator, UserAccount } from "../authentication/index.ts";
import { refuse } from "./refusal.ts";

/** Answers for an authenticated account, with a body served as 200. */
export type AccountHandler = (account: UserAccount) => Promise<unknown>;

/**
 * Wraps a route that needs a User account and nothing more: not a Person, not a
 * School, so neither http/school-scope.ts nor http/platform-scope.ts fits.
 *
 * The handler is reached only with an account, and never holds the reply, so it
 * can neither skip authentication nor phrase a refusal of its own. A request
 * belonging to no account is logged with its true reason and refused with the
 * one refusal (ADR-0002). A refusal here names no School, so it has no trail to
 * be recorded in, and goes to the log alone.
 */
export function forAccount(authenticator: Authenticator, handler: AccountHandler): RouteHandlerMethod {
  return async (request, reply) => {
    const { account, failure } = await authenticator.authenticate(request);
    if (account === null) {
      request.log.info({ reason: failure, url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(200).send(await handler(account));
  };
}
