import type { FastifyInstance } from "fastify";
import { findUserAccount, type Authenticator } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { InvalidRequest } from "../http/invalid-request.ts";
import { registerPlatformScope } from "../http/platform-scope.ts";
import { boundedText, fieldsOf } from "../http/request-body.ts";
import { provisionSchool } from "./index.ts";

// Validation below runs only once the Access decision has permitted the
// caller: see InvalidRequest.

function parseProvisioning(body: unknown) {
  const fields = fieldsOf(body, ["name", "schoolAdministrator"]);
  const administrator = fieldsOf(fields["schoolAdministrator"], ["username", "displayName"]);
  if (typeof administrator["username"] !== "string" || administrator["username"].length === 0) {
    throw new InvalidRequest("schoolAdministrator.username must name a User account");
  }
  return {
    name: boundedText(fields["name"], "name"),
    username: administrator["username"],
    displayName: boundedText(administrator["displayName"], "schoolAdministrator.displayName"),
  };
}

export function registerPlatformRoutes(
  app: FastifyInstance,
  database: Database,
  authenticator: Authenticator,
): void {
  registerPlatformScope(app, database, authenticator, (scope) => {
    scope.post("/schools", async (actor, { body }) => {
      const provisioning = parseProvisioning(body);
      const account = await findUserAccount(database, provisioning.username);
      if (account === null) {
        throw new InvalidRequest("schoolAdministrator.username must name a User account");
      }
      const provisioned = await provisionSchool(database, {
        name: provisioning.name,
        schoolAdministrator: { account, displayName: provisioning.displayName },
        platformAdministrator: actor.platformAdministrator,
      });
      // No Platform Administrator can provision a School membership for
      // themself, or for another: see mayHoldSchoolMembership.
      if (provisioned === null) {
        throw new InvalidRequest("schoolAdministrator.username may not name a Platform Administrator");
      }
      const { school, schoolAdministrator } = provisioned;
      return {
        school: { id: school.id, name: school.name },
        schoolAdministrator: { id: schoolAdministrator.id, displayName: schoolAdministrator.displayName },
      };
    });
  });
}
