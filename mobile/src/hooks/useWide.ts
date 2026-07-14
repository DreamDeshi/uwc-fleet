import { useWindowDimensions } from "react-native";

// The mobile-first screens (requestor / driver / auth) ship as a web app too, so
// on an office PC they render in a full desktop browser. `useWide` is the single
// breakpoint those screens use to switch from the phone column to a genuine
// desktop layout (side-by-side columns, tables, wider content cap). It matches
// the admin's WIDE_MIN (1024px) so the whole app agrees on one "this is a PC"
// line. Below it, screens keep their untouched phone layouts.
export const WIDE_MIN_WIDTH = 1024;

export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return width >= WIDE_MIN_WIDTH;
}
