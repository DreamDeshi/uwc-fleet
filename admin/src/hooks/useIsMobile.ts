import { useEffect, useState } from "react";

// True when the viewport is phone-sized. Drives the admin's mobile "lite" route
// so a fleet admin away from their desk gets a touch-friendly dispatch/approvals
// screen instead of the desktop-only dashboard.
export function useIsMobile(breakpoint = 768): boolean {
  const get = () => (typeof window !== "undefined" ? window.innerWidth <= breakpoint : false);
  const [isMobile, setIsMobile] = useState(get);

  useEffect(() => {
    const onResize = () => setIsMobile(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);

  return isMobile;
}
