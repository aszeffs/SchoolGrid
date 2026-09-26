import type { ReactNode } from "react";
import type { Course, ListedClassOffering } from "./api.ts";
import { Link } from "./Link.tsx";
import { courseHue, offeringName } from "./offerings.ts";

/**
 * A Course's name, or a Class Offering's, marked with its Course's colour: a
 * chip beside the words, which stay ink on the sheet (DESIGN.md: The Neutral
 * Reading Rule).
 */
export function CourseName({ course, children }: { course: Course; children: ReactNode }) {
  return (
    <span className="course" data-hue={courseHue(course)}>
      <span className="course__chip" aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * One Term's Class Offerings as the staff room's wall chart: each a block in
 * its Course's colour, with its code, name, Faculty and roster size, opening
 * on the offering's own page. Pointing at one, or moving the focus to it,
 * keeps its Course's blocks bright and dims the rest. The Course pointed at is
 * held by the page, so the record beside the chart can do the same.
 */
export function CourseChart({
  label,
  schoolId,
  offerings,
  pointed,
  onPoint,
}: {
  label: string;
  schoolId: string;
  offerings: ListedClassOffering[];
  pointed: string | null;
  onPoint: (courseId: string | null) => void;
}) {
  if (offerings.length === 0) {
    return null;
  }
  return (
    <ul className="chart" aria-label={label}>
      {offerings.map((offering) => (
        <li
          key={offering.id}
          data-hue={courseHue(offering.course)}
          data-dimmed={isDimmed(pointed, offering.course) ? "" : undefined}
          onPointerEnter={() => onPoint(offering.course.id)}
          onPointerLeave={() => onPoint(null)}
          onFocus={() => onPoint(offering.course.id)}
          onBlur={() => onPoint(null)}
        >
          <Link to={{ name: "classOffering", schoolId, classOfferingId: offering.id }}>
            {offering.course.code !== null && <code>{offering.course.code}</code>}
            <b>{offeringName(offering)}</b>
            <span>
              {offering.faculty.length === 0
                ? "No one assigned"
                : offering.faculty.map((person) => person.displayName).join(", ")}
            </span>
            <span className="chart__count">
              {offering.rosterSize === 0 ? (
                "No Students"
              ) : (
                <>
                  <strong>{offering.rosterSize}</strong> {offering.rosterSize === 1 ? "Student" : "Students"}
                </>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Whether a Course's blocks and rows step back: another Course is being pointed at. */
export function isDimmed(pointed: string | null, course: Course): boolean {
  return pointed !== null && pointed !== course.id;
}
