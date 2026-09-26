import { useState, type ReactNode } from "react";
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
 * keeps its Course's blocks bright and dims the rest; `onPoint` says which
 * Course that is, so the record beside the chart can do the same.
 */
export function CourseChart({
  label,
  schoolId,
  offerings,
  onPoint,
}: {
  label: string;
  schoolId: string;
  offerings: ListedClassOffering[];
  onPoint: (courseId: string | null) => void;
}) {
  const [pointed, setPointed] = useState<string | null>(null);
  const point = (courseId: string | null) => {
    setPointed(courseId);
    onPoint(courseId);
  };
  if (offerings.length === 0) {
    return null;
  }
  return (
    <ul className="chart" aria-label={label}>
      {offerings.map((offering) => (
        <li
          key={offering.id}
          data-hue={courseHue(offering.course)}
          data-dimmed={pointed !== null && pointed !== offering.course.id ? "" : undefined}
          onPointerEnter={() => point(offering.course.id)}
          onPointerLeave={() => point(null)}
          onFocus={() => point(offering.course.id)}
          onBlur={() => point(null)}
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
              <strong>{offering.rosterSize}</strong> {offering.rosterSize === 1 ? "Student" : "Students"}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
