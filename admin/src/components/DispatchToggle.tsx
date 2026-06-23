import { colors, radius } from "@/theme";
import { useDispatchMode, type DispatchMode } from "@/lib/dispatchMode";

// Manual / Fully-Automatic dispatch toggle. UI only for now (Phase 5 wires the
// auto-dispatch engine) — labelled as such so it's clear nothing auto-assigns yet.
export function DispatchToggle({ compact = false }: { compact?: boolean }) {
  const [mode, setMode] = useDispatchMode();
  const options: { value: DispatchMode; label: string }[] = [
    { value: "manual", label: "Manual Dispatch" },
    { value: "auto", label: "Fully Automatic" },
  ];

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {!compact && (
        <span style={{ fontSize: 12.5, fontWeight: 600, color: colors.textMuted }}>Dispatch Mode</span>
      )}
      <div style={{ display: "inline-flex", background: colors.panel, border: `1px solid ${colors.border}`, borderRadius: radius.pill, padding: 3 }}>
        {options.map((o) => {
          const active = mode === o.value;
          return (
            <button
              key={o.value}
              onClick={() => setMode(o.value)}
              style={{
                padding: "7px 14px",
                borderRadius: radius.pill,
                border: "none",
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: 700,
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
        <span style={{ fontSize: 11.5, color: colors.amber, fontWeight: 600 }}>
          Phase 5 — engine not active yet
        </span>
      )}
    </div>
  );
}
