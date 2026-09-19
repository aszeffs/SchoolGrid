import type { FastifyRequest, RouteHandlerMethod } from "fastify";
import { refuse } from "./refusal.ts";

/**
 * Resolves a request to whoever it belongs to, or says why it belongs to
 * nobody. `Authenticator.authenticate` in authentication/index.ts is the one
 * of these the application has; taking the function rather than the
 * Authenticator keeps this module, like the rest of http/, knowing nothing
 * about how a session is read.
 */
export type Authenticate<Account> = (
  request: FastifyRequest,
) => Promise<{ account: Account | null; failure?: string }>;

/** Answers for the account a request belongs to, with a body served as 200. */
export type AccountHandler<Account> = (account: Account) => Promise<unknown>;

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
export function forAccount<Account>(
  authenticate: Authenticate<Account>,
  handler: AccountHandler<Account>,
): RouteHandlerMethod {
  return async (request, reply) => {
    const { account, failure } = await authenticate(request);
    if (account === null) {
      request.log.info({ reason: failure, url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(200).send(await handler(account));
  };
}
