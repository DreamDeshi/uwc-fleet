import { useDispatchMode as useDispatchModeQuery, useSetDispatchMode } from "../hooks/queries";

// Manual vs Fully-Automatic dispatch (Mr. Teh's requirement). Backed by the API
// (GET/PATCH /settings/dispatch-mode) so the mode is shared across all admins
// and actually drives the auto-dispatch engine — not just this browser.
export type DispatchMode = "manual" | "auto";

// Keeps the original [mode, setMode] tuple shape so DispatchToggle is unchanged.
// `pending` lets the UI disable the control while a switch is in flight.
export function useDispatchMode(): [DispatchMode, (m: DispatchMode) => void, boolean] {
  const query = useDispatchModeQuery();
  const mutation = useSetDispatchMode();
  const mode: DispatchMode = query.data ?? "manual";
  const setMode = (m: DispatchMode) => mutation.mutate(m);
  return [mode, setMode, query.isLoading || mutation.isPending];
}
