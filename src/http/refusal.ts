import type { FastifyReply } from "fastify";

/**
 * The one body served for every refusal.
 *
 * ADR-0002 requires that an absent record, a record in another School, and a
 * record the caller may not read be indistinguishable. Naming this after any
 * one of those cases — `not_found`, `forbidden` — would bake the rejected
 * two-tier scheme into the shape before ticket 03 builds the real chokepoint
 * on top of it.
 */
const REFUSED = { status: "refused" } as const;

/**
 * Sends the refusal. It takes no reason, deliberately: the reason for a refusal
 * goes to the log (and, from ticket 05, the Audit record), never to the caller.
 */
export function refuse(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(REFUSED);
}
