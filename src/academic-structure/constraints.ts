import { Conflict, type ConflictDetail } from "../http/conflict.ts";

/**
 * Runs a write that one of the database's own constraints may refuse, refusing
 * it instead as the Conflict that constraint stands for. Where the database
 * holds a rule, it holds it against every interleaving of concurrent changes,
 * which a check made first and a write made after could not.
 *
 * A violation of any other constraint is left as the fault it is.
 */
export async function withConstraintsNamed<T>(
  conflicts: Readonly<Record<string, ConflictDetail>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const detail = conflicts[violatedConstraint(error) ?? ""];
    if (detail !== undefined) {
      throw new Conflict(detail);
    }
    throw error;
  }
}

/** The constraint a failed write violated, or null for a failure of any other kind. */
function violatedConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  // Class 23 is every integrity constraint violation.
  return typeof code === "string" && code.startsWith("23") && typeof constraint === "string" ? constraint : null;
}
