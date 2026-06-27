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
