// WEB scrollbar restyle (owner ask, 30 Aug 2026): the browser default is a
// full-width grey track with arrow-button end caps, which looks like a
// leftover desktop-OS control sitting inside cards and dropdowns designed
// for a phone-first app. Restyled to a thin, low-contrast thumb that only
// darkens on hover — scrolling still works exactly the same, it is just no
// longer the loudest thing on the panel. Applied globally (every scroll
// container, not per-screen) so it can't drift between panels the way a
// per-ScrollView tweak would. No-op on native (no document).
export function installWebScrollbars(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("uwc-web-scrollbars")) return;

  const style = document.createElement("style");
  style.id = "uwc-web-scrollbars";
  style.textContent = `
    * {
      scrollbar-width: thin;
      scrollbar-color: #c1c7d6 transparent;
    }
    ::-webkit-scrollbar { width: 9px; height: 9px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-corner { background: transparent; }
    ::-webkit-scrollbar-button { display: none; height: 0; width: 0; }
    ::-webkit-scrollbar-thumb {
      background: #c1c7d6;
      border-radius: 999px;
      border: 2px solid transparent;
      background-clip: padding-box;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #98a2b3;
      background-clip: padding-box;
    }
  `;
  document.head.append(style);
}
