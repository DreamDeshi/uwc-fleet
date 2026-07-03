-- Admin unassign/reassign on assigned trips (client-approved ops lever,
-- Mr. Teh 3 Jul 2026): two new immutable timeline milestones.
ALTER TYPE "TripEvent" ADD VALUE 'unassigned';
ALTER TYPE "TripEvent" ADD VALUE 'reassigned';
