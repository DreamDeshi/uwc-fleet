// The driver status-transition request body (start / arrived / delivered).
//
// A FIXED shape — `action` plus an optional `stop_id`, and NOTHING else. There is
// deliberately NO arrival/delivery timestamp field: the time is the SERVER's
// clock at the moment the driver's tap is received (`arrived_at: new Date()` in
// the API), never a client-chosen or client-editable value.
//
// Authoritative source — Mr. Teh, WhatsApp 23 Jul 2026: "u using server timeframe
// right, mean the moment driver press arrived, the time clocked will be auto
// capture, not select the time by themself." Centralised here so every caller
// (the online mutation and the offline outbox replay) sends the same
// timestamp-free body.
export type TripStatusAction = "start" | "arrived" | "delivered";

export function statusRequestBody(
  action: TripStatusAction,
  stop_id?: string
): { action: TripStatusAction; stop_id?: string } {
  return { action, stop_id };
}
