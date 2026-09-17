import type { FastifyInstance } from "fastify";
import {
  authorizeCreatePerson,
  authorizeReadPerson,
  mayReadClaimedState,
  reachableSchools,
  readablePersons,
} from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction } from "../db/transaction.ts";
import { refuse } from "../http/refusal.ts";
import { boundedText, fieldsOf } from "../http/request-body.ts";
import { registerSchoolScope } from "../http/school-scope.ts";
import { createPerson, findPerson, personsInSchool, type ListedPerson, type Person } from "./index.ts";

/** A Person as served. The School is the one the caller addressed. */
function present({ id, displayName }: Person) {
  return { id, displayName };
}

/** A Person as served in a listing, with whether they are claimed only when the caller may see it. */
function presentListed(person: ListedPerson, withClaimedState: boolean) {
  return withClaimedState ? { ...present(person), claimed: person.claimed } : present(person);
}

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

/**
 * A Person is created from a display name alone, and attached to no User
 * account: that is for the human behind the record to claim, not for a School
 * Administrator to assign.
 */
function parseCreation(body: unknown) {
  return { displayName: boundedText(fieldsOf(body, ["displayName"])["displayName"], "displayName") };
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
      const persons = readablePersons(actor, await personsInSchool(database, actor.schoolId));
      // Left out entirely for anyone else, rather than sent empty: see mayReadClaimedState.
      const withClaimedState = mayReadClaimedState(actor);
      return { persons: persons.map((person) => presentListed(person, withClaimedState)) };
    });

    scope.post("/persons", async (actor, { body }) => {
      const schoolId = authorizeCreatePerson(actor);
      const { displayName } = parseCreation(body);
      return withTransaction(database, async (transaction) => {
        const person = await createPerson(transaction, { schoolId, displayName });
        await appendAuditRecord(transaction, {
          schoolId,
          actorPersonId: actor.person.id,
          action: "person.created",
          target: { type: "person", id: person.id },
          reason: null,
          before: null,
          after: { displayName },
        });
        // Only a School Administrator creates a Person, and one just created
        // is attached to no account.
        return { person: presentListed({ ...person, claimed: false }, true) };
      });
    });

    scope.get("/persons/:personId", async (actor, { params: { personId } }) => {
      const person = authorizeReadPerson(actor, personId!, await findPerson(database, personId!));
      return { person: present(person) };
    });
  });
}
