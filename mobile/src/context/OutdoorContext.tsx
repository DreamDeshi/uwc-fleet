import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { loadOutdoorMode, saveOutdoorMode } from "../lib/outdoorMode";

/**
 * Outdoor mode, held once for the whole app.
 *
 * It is a DEVICE preference (see lib/outdoorMode for the ruling), so it is read
 * once at startup and never re-read per user — signing in and out does not
 * change the weather.
 *
 * Mounted above the navigator so a driver toggling it in Profile sees every
 * screen change at once rather than on next mount.
 */
interface OutdoorValue {
  outdoorOn: boolean;
  setOutdoor: (on: boolean) => void;
}

const OutdoorContext = createContext<OutdoorValue>({ outdoorOn: false, setOutdoor: () => {} });

export function OutdoorProvider({ children }: { children: React.ReactNode }) {
  const [outdoorOn, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadOutdoorMode().then((v) => {
      if (alive) setOn(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setOutdoor = useCallback((on: boolean) => {
    // Optimistic: the switch must move under the thumb even if the write is
    // slow, and a failed write only costs the preference on next launch.
    setOn(on);
    void saveOutdoorMode(on);
  }, []);

  return <OutdoorContext.Provider value={{ outdoorOn, setOutdoor }}>{children}</OutdoorContext.Provider>;
}

/**
 * ⚠ DRIVER SURFACES ONLY. The requestor and admin share several of these
 * components; this hook is what keeps the override at the COMPONENT rather
 * than at the token (owner ruling, 17 Aug), so switching it on cannot drag the
 * requestor's palette along behind it.
 */
export function useOutdoor(): OutdoorValue {
  return useContext(OutdoorContext);
}
