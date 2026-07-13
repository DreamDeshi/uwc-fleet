// WEB build: load Inter (the old web admin's typeface, same Google Fonts URL
// and weights as admin/index.html) and apply it to the admin subtree only —
// everything under [data-uwc-admin]. Driver/requestor screens keep the system
// font; native resolves the no-op webFonts.ts instead.
//
// The !important is deliberate: react-native-web sets font-family per <Text>
// via generated atomic classes, and this scoped override must beat them.
const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";

export function installAdminWebFonts(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("uwc-admin-fonts")) return;

  const preconnect = document.createElement("link");
  preconnect.rel = "preconnect";
  preconnect.href = "https://fonts.googleapis.com";

  const link = document.createElement("link");
  link.id = "uwc-admin-fonts";
  link.rel = "stylesheet";
  link.href = FONTS_HREF;

  const style = document.createElement("style");
  style.id = "uwc-admin-font-scope";
  // Ionicons sits LAST in the stack: normal text resolves to Inter, but the
  // icon glyphs live in Private-Use-Area codepoints no text font covers, so
  // per-character fallback walks through to the icon font — without this the
  // override turns every vector icon into a tofu box.
  style.textContent = `
    [data-uwc-admin], [data-uwc-admin] * {
      font-family: "Inter", system-ui, -apple-system, sans-serif, "Ionicons" !important;
      -webkit-font-smoothing: antialiased;
    }
  `;

  document.head.append(preconnect, link, style);
}

// RNW-only View prop (data-* attribute) that scopes the font override; typed
// loosely because react-native's types don't know dataSet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const adminFontScope: any = { dataSet: { uwcAdmin: "" } };
