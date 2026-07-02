import { Prisma } from "@prisma/client";

/**
 * True when a Prisma error is a transaction write-conflict / deadlock — i.e. a
 * Postgres serialization failure (SQLSTATE 40001) or deadlock (40P01), which
 * Prisma surfaces as P2034 under Serializable isolation. Callers translate this
 * into a 409 so a concurrent writer is told to retry rather than getting a 500.
 */
export function isSerializationConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

/**
 * True when a Prisma error is a unique-constraint violation (P2002), optionally
 * scoped to a specific column. Used to retry ticket-number generation when two
 * bookings race the count-then-create window instead of 500ing one of them.
 */
export function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  if (!field) return true;
  const target = (err.meta as { target?: string[] | string } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === "string") return target.includes(field);
  // No target metadata — treat as a match rather than crash the retry loop.
  return true;
}
