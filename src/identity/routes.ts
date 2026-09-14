import type { FastifyInstance } from "fastify";
import { authorizeReadPerson, readablePersons } from "../access/index.ts";
import { accountForRequest } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { refuse } from "../http/refusal.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { findPerson, personsInSchool, schoolsReachedBy, type Person } from "./index.ts";

/** A Person as served. The School is the one the caller addressed. */
function present({ id, displayName }: Person) {
  return { id, displayName };
}

export function registerIdentityRoutes(app: FastifyInstance, database: Database): void {
  // Not School-scoped: it answers which Schools a caller may choose to act in.
  // A School the account does not reach is simply not listed.
  app.get("/schools", async (request, reply) => {
    const account = await accountForRequest(database, request);
    if (account === null) {
      request.log.info({ reason: "unauthenticated", url: request.url }, "refused");
      return refuse(reply);
    }
    return reply.status(200).send({ schools: await schoolsReachedBy(database, account.id) });
  });

  registerSchoolScope(app, database, (scope) => {
    scope.get("/persons", async (actor) => {
      const persons = await personsInSchool(database, actor.schoolId);
      return { persons: readablePersons(actor, persons).map(present) };
    });

    scope.get("/persons/:personId", async (actor, { personId }) => {
      const person = authorizeReadPerson(actor, personId!, await findPerson(database, personId!));
      return { person: present(person) };
    });
  });
}
