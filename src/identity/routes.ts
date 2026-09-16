import type { FastifyInstance } from "fastify";
import { authorizeReadPerson, reachableSchools, readablePersons } from "../access/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { refuse } from "../http/refusal.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPerson, personsInSchool, type Person } from "./index.ts";

/** A Person as served. The School is the one the caller addressed. */
function present({ id, displayName }: Person) {
  return { id, displayName };
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  // Not School-scoped: it answers which Schools a caller may choose to act in.
  // A School the account does not reach, or reaches only through memberships
  // that are not in force, is simply not listed.
  app.get("/schools", async (request, reply) => {
    const { account, failure } = await authenticator.authenticate(request);
    if (account === null) {
      request.log.info({ reason: failure, url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(200).send({ schools: await reachableSchools(database, account) });
  });

  registerSchoolScope(app, database, authenticator, (scope) => {
    scope.get("/persons", async (actor) => {
      const persons = await personsInSchool(database, actor.schoolId);
      return { persons: readablePersons(actor, persons).map(present) };
    });

    scope.get("/persons/:personId", async (actor, { params: { personId } }) => {
      const person = authorizeReadPerson(actor, personId!, await findPerson(database, personId!));
      return { person: present(person) };
    });
  });
}
