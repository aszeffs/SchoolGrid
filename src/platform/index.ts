import { grantMembership } from "../access/index.ts";
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
  administrator: Person;
}

/**
 * Creates a School together with its first School Administrator, so the School
 * can manage itself from then on. Both exist or neither does: a School nobody
 * can administer could never be repaired from inside it.
 */
export function provisionSchool(
  database: Database,
  {
    name,
    administrator,
  }: { name: string; administrator: { userAccountId: string; displayName: string } },
): Promise<ProvisionedSchool> {
  return withTransaction(database, async (client) => {
    const school = await createSchool(client, { name });
    const person = await createPerson(client, { schoolId: school.id, ...administrator });
    await grantMembership(client, { person, role: "school_administrator" });
    return { school, administrator: person };
  });
}
