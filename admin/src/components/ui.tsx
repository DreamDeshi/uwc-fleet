import type { CSSProperties, ReactNode } from "react";
import { colors, radius, shadow, tripStatusColor, tripStatusLabel } from "@/theme";
import { initials } from "@/lib/format";
import { useIsMobile } from "@/hooks/useIsMobile";

// ── Card ─────────────────────────────────────────────────────────────
export function Card({
  children,
  style,
  pad = 20,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  pad?: number;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: colors.card,
        borderRadius: radius.lg,
        boxShadow: shadow.card,
        border: `1px solid ${colors.border}`,
        padding: pad,
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      {/* Corporate-yellow tick before every section title — the small, repeated
          brand mark that makes each card read as deliberately composed. */}
      <div style={{ display: "flex", gap: 10 }}>
        <span
          style={{
            width: 4,
            borderRadius: 2,
            background: colors.yellow,
            alignSelf: "stretch",
            marginTop: 2,
            marginBottom: 2,
            flexShrink: 0,
          }}
        />
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: colors.text, letterSpacing: -0.2 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>{subtitle}</div>}
        </div>
      </div>
      {right}
    </div>
  );
}

// ── KPI card (gradient-filled stat tile, optional click-through) ─────
// The dashboard's headline numbers: brand-gradient fill, a same-hue soft
// shadow so the tile floats, decorative corner discs for depth, and a
// display-size value. `shadowColor` takes a kpiShadow token; `bg` a
// gradients token (plain colors still work for any legacy caller).
export function KpiCard({
  label,
  value,
  sub,
  bg,
  fg,
  accent,
  icon,
  onClick,
  shadowColor,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  bg: string;
  fg: string;
  accent: string;
  icon?: ReactNode;
  onClick?: () => void;
  shadowColor?: string;
}) {
  return (
    <div
      className="uwc-kpi"
      onClick={onClick}
      style={{
        background: bg,
        color: fg,
        borderRadius: radius.xl,
        padding: "20px 22px",
        boxShadow: shadowColor ?? shadow.card,
        cursor: onClick ? "pointer" : undefined,
        position: "relative",
        overflow: "hidden",
        minHeight: 142,
      }}
    >
      {/* Decorative depth: two translucent discs bleeding off the corner. */}
      <div style={{ position: "absolute", right: -34, top: -34, width: 130, height: 130, borderRadius: "50%", background: "rgba(255,255,255,0.09)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", right: 26, bottom: -48, width: 96, height: 96, borderRadius: "50%", background: "rgba(255,255,255,0.07)", pointerEvents: "none" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", position: "relative" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.9 }}>
          {label}
        </div>
        {icon && (
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              background: accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {icon}
          </div>
        )}
      </div>
      <div style={{ fontSize: 44, fontWeight: 800, marginTop: 8, lineHeight: 1, letterSpacing: -1, position: "relative" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.9, marginTop: 9, position: "relative" }}>{sub}</div>}
    </div>
  );
}

// ── Button ───────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "accent" | "success" | "danger" | "outline" | "ghost";
// Filled variants sit on a soft same-hue shadow so primary actions read as
// the raised element on the page; outline/ghost stay flat by design.
const buttonStyles: Record<ButtonVariant, CSSProperties> = {
  primary: { background: colors.blue, color: "#fff", boxShadow: "0 6px 14px -6px rgba(0,48,135,0.5)" },
  accent: { background: colors.yellow, color: colors.navy, boxShadow: "0 6px 14px -6px rgba(214,158,0,0.5)" },
  success: { background: colors.green, color: "#fff", boxShadow: "0 6px 14px -6px rgba(46,127,36,0.45)" },
  danger: { background: colors.red, color: "#fff", boxShadow: "0 6px 14px -6px rgba(183,28,28,0.45)" },
  outline: { background: "transparent", color: colors.blue, border: `1.5px solid ${colors.blue}` },
  ghost: { background: colors.panel, color: colors.text, border: `1px solid ${colors.border}` },
};

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  type = "button",
  full,
  size = "md",
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
  size?: "sm" | "md";
  style?: CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        ...buttonStyles[variant],
        padding: size === "sm" ? "8px 14px" : "11px 18px",
        borderRadius: radius.md,
        border: buttonStyles[variant].border ?? "none",
        fontWeight: 700,
        fontSize: size === "sm" ? 13.5 : 14,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        width: full ? "100%" : undefined,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        transition: "filter 0.15s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── Generic pill / badge ─────────────────────────────────────────────
export function Pill({
  children,
  bg,
  fg,
  border,
  dot,
}: {
  children: ReactNode;
  bg: string;
  fg: string;
  border?: string;
  dot?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: bg,
        color: fg,
        border: border ? `1px solid ${border}` : undefined,
        padding: "4px 10px",
        borderRadius: radius.pill,
        fontSize: 13,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot }} />}
      {children}
    </span>
  );
}

// Status is a first-class signal on every board and table, so the badge is
// deliberately louder than a generic Pill: uppercase micro-type, a strong
// tinted fill with a real border, and the status dot. The label is always
// text — color is reinforcement, never the only channel.
export function TripStatusBadge({ status }: { status: string }) {
  const c = tripStatusColor[status] ?? tripStatusColor.pending;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: c.bg,
        color: c.fg,
        border: `1.5px solid ${c.border}`,
        padding: "4px 10px",
        borderRadius: radius.pill,
        fontSize: 11.5,
        fontWeight: 800,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.dot, flexShrink: 0 }} />
      {tripStatusLabel[status] ?? status}
    </span>
  );
}

// ── Avatar (navy circle, yellow initials/glyph) ──────────────────────
export function Avatar({ name, size = 38, glyph }: { name?: string; size?: number; glyph?: ReactNode }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: colors.blue,
        border: `2px solid ${colors.yellow}`,
        color: colors.yellow,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.36,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {glyph ?? (name ? initials(name) : "?")}
    </div>
  );
}

// ── Search input ─────────────────────────────────────────────────────
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div
      className="uwc-input"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: radius.md,
        padding: "9px 12px",
        minWidth: 240,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="11" cy="11" r="7" stroke={colors.textFaint} strokeWidth="2" />
        <path d="M21 21l-4-4" stroke={colors.textFaint} strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ border: "none", outline: "none", fontSize: 14, flex: 1, background: "transparent", color: colors.text }}
      />
    </div>
  );
}

// ── Segmented filter with counts ─────────────────────────────────────
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="uwc-lift"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 15px",
              borderRadius: radius.pill,
              border: `1.5px solid ${active ? colors.blue : colors.border}`,
              background: active ? colors.blue : colors.card,
              color: active ? "#fff" : colors.textMuted,
              fontWeight: 700,
              fontSize: 14,
              cursor: "pointer",
              boxShadow: active ? "0 6px 14px -6px rgba(0,48,135,0.5)" : undefined,
            }}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                style={{
                  background: active ? "rgba(255,255,255,0.22)" : colors.panel,
                  color: active ? "#fff" : colors.textMuted,
                  borderRadius: radius.pill,
                  padding: "1px 7px",
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Progress bar ─────────────────────────────────────────────────────
export function ProgressBar({ pct, color = colors.blue, height = 8 }: { pct: number; color?: string; height?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ background: colors.divider, borderRadius: radius.pill, height, width: "100%", overflow: "hidden" }}>
      <div style={{ width: `${clamped}%`, height: "100%", background: color, borderRadius: radius.pill, transition: "width 0.3s" }} />
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: number;
}) {
  // Slimmer gutters on a phone so the dialog gets the width; desktop values
  // are untouched.
  const mobile = useIsMobile();
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16,24,40,0.5)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: mobile ? 10 : 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.card,
          borderRadius: radius.xl,
          width,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: shadow.floating,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: `1px solid ${colors.border}`,
            background: colors.panel,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 4, height: 16, borderRadius: 2, background: colors.yellow, flexShrink: 0 }} />
            <div style={{ fontSize: 16, fontWeight: 800 }}>{title}</div>
          </div>
          <button
            onClick={onClose}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: colors.textMuted, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: mobile ? 14 : 20 }}>{children}</div>
      </div>
    </div>
  );
}

// ── Table scroll container ───────────────────────────────────────────
// Wide data tables must never overflow the viewport: on a narrow screen the
// table keeps its natural column widths and pans sideways inside its card
// instead of pushing the page wider. On desktop the card is wider than
// minWidth, so nothing scrolls and the table renders exactly as before.
export function TableScroll({ children, minWidth = 640 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <div style={{ minWidth }}>{children}</div>
    </div>
  );
}

// ── Confirm dialog ───────────────────────────────────────────────────
// Generic Cancel/Confirm modal for destructive actions (same shape as the
// reject-booking / reset-rates dialogs). The caller keeps its own error
// display; on success it should close the dialog itself.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  pending,
  onClose,
  onConfirm,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open onClose={onClose} title={title} width={420}>
      <div style={{ fontSize: 14, color: colors.text, lineHeight: 1.6, marginBottom: 14 }}>
        {body}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="ghost" full onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button variant="danger" full onClick={onConfirm} disabled={pending}>
          {pending ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ── Form input ───────────────────────────────────────────────────────
export function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      {label && <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>{label}</div>}
      <input
        className="uwc-input"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "11px 13px",
          borderRadius: radius.md,
          border: `1px solid ${colors.border}`,
          fontSize: 14,
          outline: "none",
          color: colors.text,
        }}
      />
    </label>
  );
}

// ── States ───────────────────────────────────────────────────────────
export function Spinner({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: `3px solid ${colors.border}`,
        borderTopColor: colors.blue,
        borderRadius: "50%",
        animation: "uwc-spin 0.8s linear infinite",
      }}
    />
  );
}

export function CenterState({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 50, color: colors.textMuted }}>
      {children}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <CenterState>
      <Spinner />
      <div style={{ fontSize: 14 }}>{label}</div>
    </CenterState>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <CenterState>
      <div style={{ fontSize: 14, color: colors.red, fontWeight: 600 }}>{message}</div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </CenterState>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <CenterState>
      <div style={{ fontSize: 14 }}>{message}</div>
    </CenterState>
  );
}
