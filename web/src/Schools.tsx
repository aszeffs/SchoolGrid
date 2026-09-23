import type { ReachedSchool } from "./api.ts";
import { Link } from "./Link.tsx";
import { landing } from "./routes.ts";
import { Key, Sheet } from "./Sheet.tsx";

/**
 * The Schools the account reaches, to pick one from. Shown only for none or
 * several: an account reaching exactly one goes straight into it.
 */
export function Schools({ schools }: { schools: ReachedSchool[] }) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>The Schools your account reaches.</p>
      <dl>
        <Key term="School">
          The boundary every record belongs to. No record is shared between Schools, and the same human at two Schools
          is two unrelated Persons.
        </Key>
        <Key term="Reach">
          Your account resolves to at most one Person per School. A School you cannot reach is not listed.
        </Key>
      </dl>
    </>
  );
  return (
    <Sheet name="Schools" legend={legend}>
      <h1>Your Schools</h1>
      {schools.length === 0 ? (
        <p className="empty">Your account does not reach any School yet.</p>
      ) : (
        <ul aria-label="Schools" className="roster">
          {schools.map((school) => (
            <li key={school.schoolId}>
              <span className="roster__name">
                <Link to={landing(school.schoolId, school.roles)}>{school.name}</Link>
              </span>
              {/* The leader carries no text: a listed School reads as its name and nothing else. */}
              <span className="roster__leader" />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
