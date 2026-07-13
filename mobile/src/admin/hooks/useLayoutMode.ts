import { useWindowDimensions } from "react-native";

// The admin's two layout worlds. "wide" (PC / tablet-landscape, ≥1024px)
// keeps the permanent sidebar and side-by-side panes; "narrow" (phone)
// collapses to a hamburger drawer and stacked layouts. One breakpoint for
// the whole in-app admin so screens never disagree with the shell.
export type LayoutMode = "wide" | "narrow";

export const WIDE_MIN_WIDTH = 1024;

export function useLayoutMode(): LayoutMode {
  const { width } = useWindowDimensions();
  return width >= WIDE_MIN_WIDTH ? "wide" : "narrow";
}
