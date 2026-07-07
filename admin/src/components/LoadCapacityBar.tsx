import { colors, radius } from "@/theme";

// Lorry-fill visualiser (Mr. Teh's requirement): a segmented pallet bar showing
// how full a truck is right now. Colour shifts as it approaches capacity.
export function LoadCapacityBar({
  load,
  capacity,
  compact = false,
}: {
  load: number;
  capacity: number;
  compact?: boolean;
}) {
  const pct = capacity > 0 ? Math.min(100, (load / capacity) * 100) : 0;
  const fillColor = pct >= 90 ? colors.red : pct >= 60 ? colors.orange : colors.green;

  // Render up to ~16 pallet segments; collapse to a single bar for large trucks
  // in compact mode to avoid clutter.
  const showSegments = !compact && capacity <= 16;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textMuted, display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <rect x="1" y="6" width="14" height="10" rx="1.5" stroke={colors.textMuted} strokeWidth="1.6" />
            <path d="M15 9h4l3 3v4h-7z" stroke={colors.textMuted} strokeWidth="1.6" strokeLinejoin="round" />
            <circle cx="6" cy="17" r="1.6" stroke={colors.textMuted} strokeWidth="1.6" />
            <circle cx="19" cy="17" r="1.6" stroke={colors.textMuted} strokeWidth="1.6" />
          </svg>
          Load
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: fillColor }}>
          {load}/{capacity} pallets
        </span>
      </div>

      {showSegments ? (
        <div style={{ display: "flex", gap: 3 }}>
          {Array.from({ length: capacity }).map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: 14,
                borderRadius: 3,
                background: i < load ? fillColor : colors.divider,
                border: `1px solid ${i < load ? fillColor : colors.border}`,
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ background: colors.divider, borderRadius: radius.pill, height: 12, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: fillColor, borderRadius: radius.pill, transition: "width 0.3s" }} />
        </div>
      )}
    </div>
  );
}
