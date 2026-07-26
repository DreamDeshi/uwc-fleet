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

/**
 * Like `isUniqueViolation`, but requires the driver to NAME the column: with no
 * target metadata this returns FALSE where `isUniqueViolation` returns true.
 *
 * Use it when two different unique constraints on the same table are handled
 * differently and guessing wrong changes the outcome. The booking-create path is
 * exactly that case: `ticket_number` collisions must be RETRIED, while
 * `client_request_id` collisions must return the existing trip. Letting the
 * permissive fallback answer there would turn a retryable ticket collision into
 * a spurious idempotency conflict.
 */
export function isUniqueViolationOnField(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
    return false;
  }
  const target = (err.meta as { target?: string[] | string } | undefined)?.target;
  if (Array.isArray(target)) return target.includes(field);
  if (typeof target === "string") return target.includes(field);
  return false;
}
