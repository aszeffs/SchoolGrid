import { grantMembership } from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction } from "../db/transaction.ts";
import { createPerson, createSchool, type Person, type School } from "../identity/index.ts";

/**
 * Platform operations act on a School from outside it. Only bootstrapping
 * exists so far; ticket 10 gives the Platform Administrator an actor and proves
 * it reaches no School-scoped record.
 */
export interface ProvisionedSchool {
  school: School;
  schoolAdministrator: Person;
}

/**
 * Creates a School together with its first School Administrator, so the School
 * can manage itself from then on. Both exist or neither does: a School nobody
 * can administer could never be repaired from inside it.
 *
 * The provisioning is recorded in the School's own trail in the same
 * transaction, so it cannot happen unrecorded. No Person acted: ticket 10 gives
 * the Platform Administrator an actor to record.
 */
export function provisionSchool(
  database: Database,
  {
    name,
    schoolAdministrator,
  }: { name: string; schoolAdministrator: { userAccountId: string; displayName: string } },
): Promise<ProvisionedSchool> {
  return withTransaction(database, async (client) => {
    const school = await createSchool(client, { name });
    const person = await createPerson(client, { schoolId: school.id, ...schoolAdministrator });
    await grantMembership(client, { person, role: "school_administrator" });
    await appendAuditRecord(client, {
      schoolId: school.id,
      actorPersonId: null,
      action: "school.provisioned",
      target: { type: "school", id: school.id },
      reason: null,
      before: null,
      after: { name: school.name, schoolAdministratorPersonId: person.id },
    });
    return { school, schoolAdministrator: person };
  });
}
