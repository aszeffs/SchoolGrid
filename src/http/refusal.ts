import type { FastifyReply } from "fastify";

/**
 * The one body served for every refusal.
 *
 * ADR-0002 requires that an absent record, a record in another School, and a
 * record the caller may not read be indistinguishable. Naming this after any
 * one of those cases — `not_found`, `forbidden` — would bake the rejected
 * two-tier scheme into the shape.
 */
const REFUSED = { status: "refused" } as const;

/**
 * Sends the refusal: the only place in the system one is produced. It takes no
 * reason, deliberately, so no caller of it can phrase a refusal of its own. The
 * reason goes to the log (and, from ticket 05, the Audit record), never to the
 * caller. School-scoped routes reach this only through the chokepoint in
 * http/school-scope.ts, and never call it themselves.
 *
 * This will read as unhelpful error handling. It is deliberate; do not
 * "improve" it by distinguishing the cases.
 */
export function refuse(reply: FastifyReply): FastifyReply {
  return reply.status(404).send(REFUSED);
}
