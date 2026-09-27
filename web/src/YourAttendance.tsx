import { useCallback } from "react";
import { api, type ReachedSchool, type StudentAttendance } from "./api.ts";
import { NotAvailable } from "./NotAvailable.tsx";
import { useScreen } from "./screen.ts";
import { Sheet, type SheetKind } from "./Sheet.tsx";
import { StudentAttendanceKeys, StudentAttendanceRecord } from "./StudentAttendance.tsx";

/** Which sheet this page is, named once so its states cannot drift apart. */
const SHEET: SheetKind = { name: "Your attendance" };

/**
 * A Student's own Attendance and totals in each Class Offering they were on
 * the roster of, beside Your classes. Readable as soon as it is recorded, and
 * still theirs once their Enrollment has ended (CONTEXT.md: Attendance,
 * Enrollment).
 *
 * It reads, and never writes: Attendance is Faculty's to record.
 */
export function YourAttendance({ school }: { school: ReachedSchool }) {
  const read = useCallback(
    async (schoolId: string) => {
      const answered = await api.studentAttendance(schoolId, school.personId);
      return answered.ok ? { ok: true as const, body: answered.body.studentAttendance } : answered;
    },
    [school.personId],
  );
  const { showing } = useScreen(school.schoolId, read);

  switch (showing.kind) {
    case "loading":
      return <Sheet {...SHEET} busy />;
    case "not-available":
      return <NotAvailable />;
    case "ready":
      return <AttendanceSheet schoolId={school.schoolId} attendance={showing.records} />;
  }
}

function AttendanceSheet({ schoolId, attendance }: { schoolId: string; attendance: StudentAttendance }) {
  const legend = (
    <>
      <h2>Key</h2>
      <p>Your own Attendance, and nothing about anyone else&rsquo;s.</p>
      <StudentAttendanceKeys />
    </>
  );
  return (
    <Sheet {...SHEET} legend={legend}>
      <h1>Your attendance</h1>
      <StudentAttendanceRecord
        schoolId={schoolId}
        attendance={attendance}
        level="h2"
        opensOfferings
        empty="You are on no Class Offering’s roster yet, so no Attendance is held for you."
      />
    </Sheet>
  );
}
