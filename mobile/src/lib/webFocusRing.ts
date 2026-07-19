// WEB focus indication (owner ask, 2026-07-20): the browser's default blue
// outline flashed on every mouse click, looking unstyled. We want the ring to
// appear ONLY for keyboard navigation and never on mouse/touch, restyled to a
// subtle on-brand navy, applied globally (inputs, buttons, filter chips).
//
// Native CSS :focus-visible ALMOST does this, but browsers deliberately keep the
// ring on TEXT INPUTS even for a mouse click (you're expected to type), so a
// mouse-clicked input would still show a ring. To honour "no ring on mouse click
// for everything", we track input modality (the focus-visible polyfill pattern):
// a Tab/arrow keypress turns the ring on; any pointer interaction turns it off.
// No-op on native (no document); mirrors installAdminWebFonts.
const RING = "#1A1F5E"; // theme navy
const FIELD_BG = "#f4f6fb"; // theme fieldBg — what autofilled inputs should show

export function installWebFocusRing(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("uwc-focus-ring")) return;

  const root = document.documentElement;
  const keyboardOn = () => root.classList.add("uwc-kbd");
  const keyboardOff = () => root.classList.remove("uwc-kbd");

  // Capture-phase so we set modality before focus styles resolve.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) keyboardOn();
    },
    true
  );
  document.addEventListener("mousedown", keyboardOff, true);
  document.addEventListener("pointerdown", keyboardOff, true);
  document.addEventListener("touchstart", keyboardOff, true);

  const style = document.createElement("style");
  style.id = "uwc-focus-ring";
  // Default: no ring on any focus (beats the UA default + react-native-web's
  // atomic styles). Ring only while in keyboard mode — a subtle navy outline
  // that hugs the element's corners (modern browsers round outline to
  // border-radius); outline-offset gives it a little air.
  style.textContent = `
    *:focus { outline: none !important; }
    html.uwc-kbd *:focus { outline: 2px solid ${RING} !important; outline-offset: 2px; }

    /* Kill the browser autofill yellow: paint the field's own light background
       over it via an inset box-shadow, keep the text navy, and freeze the
       transition so it never flashes yellow. Applies app-wide. */
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    textarea:-webkit-autofill,
    select:-webkit-autofill {
      -webkit-box-shadow: 0 0 0 1000px ${FIELD_BG} inset !important;
      box-shadow: 0 0 0 1000px ${FIELD_BG} inset !important;
      -webkit-text-fill-color: ${RING} !important;
      caret-color: ${RING};
      transition: background-color 600000s 0s, color 600000s 0s;
    }
  `;
  document.head.append(style);
}
