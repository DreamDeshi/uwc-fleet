import { useEffect, useState } from "react";

// Manual vs Fully-Automatic dispatch (Mr. Teh's requirement). This is a UI-only
// toggle for now — the auto-dispatch bin-packing engine lands in Phase 5. The
// choice is persisted so it stays consistent between the Dashboard and Trips.
export type DispatchMode = "manual" | "auto";

const KEY = "uwc.admin.dispatchMode";

export function useDispatchMode(): [DispatchMode, (m: DispatchMode) => void] {
  const [mode, setMode] = useState<DispatchMode>(
    () => (localStorage.getItem(KEY) as DispatchMode) || "manual"
  );

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && e.newValue) setMode(e.newValue as DispatchMode);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = (m: DispatchMode) => {
    setMode(m);
    localStorage.setItem(KEY, m);
    // notify same-tab listeners (storage event only fires cross-tab)
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: m }));
  };

  return [mode, update];
}
