import { colors, radius } from "@/theme";
import { useDispatchMode, type DispatchMode } from "@/lib/dispatchMode";

// Manual / Fully-Automatic dispatch toggle. Wired to the API: switching to
// "Fully Automatic" makes new bookings auto-assign the moment they're created
// (and the 15-min sweep auto-dispatches anything still pending).
export function DispatchToggle({ compact = false }: { compact?: boolean }) {
  const [mode, setMode, pending] = useDispatchMode();
  const options: { value: DispatchMode; label: string }[] = [
    { value: "manual", label: "Manual Dispatch" },
    { value: "auto", label: "Fully Automatic" },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {!compact && (
        <span style={{ fontSize: 13, fontWeight: 600, color: colors.textMuted }}>Dispatch Mode</span>
      )}
      <div style={{ display: "inline-flex", background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: radius.pill, padding: 3 }}>
        {options.map((o) => {
          const active = mode === o.value;
          return (
            <button
              key={o.value}
              onClick={() => setMode(o.value)}
              disabled={pending}
              style={{
                padding: "7px 14px",
                borderRadius: radius.pill,
                border: "none",
                cursor: pending ? "wait" : "pointer",
                fontSize: 13,
                fontWeight: 700,
                opacity: pending ? 0.7 : 1,
                background: active ? (o.value === "auto" ? colors.green : colors.blue) : "transparent",
                color: active ? "#fff" : colors.textMuted,
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {mode === "auto" && (
        <span style={{ fontSize: 12, color: colors.green, fontWeight: 600 }}>
          Engine active — new orders auto-assign
        </span>
      )}
    </div>
  );
}
