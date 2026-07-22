// The phone's background GPS task keeps capturing even when the app is closed,
// so it needs a way to learn a trip has ENDED without the app being open. On
// every flush of POST /locations we report which of the posted trips are no
// longer active; the task self-stops any it's tracking. Pure + import-free so
// it's unit-testable in plain node (same discipline as the other lib helpers).

// A trip is "trackable" only while in_progress. Anything else — pending_approval,
// completed, cancelled, or an admin unassign that flipped it back to assigned —
// means the phone must stop capturing new fixes for it.
export function inactiveTripIds(
  trips: { id: string; status: string }[]
): string[] {
  return trips.filter((t) => t.status !== "in_progress").map((t) => t.id);
}
