import { grantMembership, mayHoldSchoolMembership } from "../access/index.ts";
import { appendAuditRecord } from "../audit/index.ts";
import type { UserAccount } from "../authentication/index.ts";
import type { Database } from "../db/pool.ts";
import { withTransaction } from "../db/transaction.ts";
import {
  createPerson,
  createSchool,
  type Person,
  type PlatformAdministrator,
  type School,
} from "../identity/index.ts";

/**
 * Platform operations act on a School from outside it. A Platform
 * Administrator performs them, and reaches nothing inside a School by doing
 * so: see resolveActor in the Access module.
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
 * transaction, so it cannot happen unrecorded, and names the Platform
 * Administrator who did it so the School can see what was done to it from
 * outside. Null only where no one acted, as when a test arranges a School.
 *
 * Returns null, creating nothing, when the account named may not hold a School
 * membership, as a Platform Administrator's may not. That is asked inside the
 * transaction that grants it.
 */
export function provisionSchool(
  database: Database,
  {
    name,
    schoolAdministrator: { account, displayName },
    platformAdministrator,
  }: {
    name: string;
    schoolAdministrator: { account: UserAccount; displayName: string };
    platformAdministrator: PlatformAdministrator | null;
  },
): Promise<ProvisionedSchool | null> {
  return withTransaction(database, async (client) => {
    if (!(await mayHoldSchoolMembership(client, account))) {
      return null;
    }
    const school = await createSchool(client, { name });
    const person = await createPerson(client, {
      schoolId: school.id,
      userAccountId: account.id,
      displayName,
    });
    await grantMembership(client, { person, role: "school_administrator" });
    await appendAuditRecord(client, {
      schoolId: school.id,
      actorPersonId: null,
      actorPlatformAdministratorId: platformAdministrator?.id ?? null,
      action: "school.provisioned",
      target: { type: "school", id: school.id },
      reason: null,
      before: null,
      after: { name: school.name, schoolAdministratorPersonId: person.id },
    });
    return { school, schoolAdministrator: person };
  });
}
