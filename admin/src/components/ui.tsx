import type { CSSProperties, ReactNode } from "react";
import { colors, radius, shadow, tripStatusColor, tripStatusLabel } from "@/theme";
import { initials } from "@/lib/format";

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
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: colors.text }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

// ── KPI card (color-filled, optional click-through) ──────────────────
export function KpiCard({
  label,
  value,
  sub,
  bg,
  fg,
  accent,
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  bg: string;
  fg: string;
  accent: string;
  icon?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: bg,
        color: fg,
        borderRadius: radius.lg,
        padding: 20,
        boxShadow: shadow.card,
        cursor: onClick ? "pointer" : undefined,
        position: "relative",
        overflow: "hidden",
        minHeight: 130,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", opacity: 0.85 }}>
          {label}
        </div>
        {icon && (
          <div
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
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
      <div style={{ fontSize: 38, fontWeight: 800, marginTop: 10, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 8 }}>{sub}</div>}
    </div>
  );
}

// ── Button ───────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "accent" | "success" | "danger" | "outline" | "ghost";
const buttonStyles: Record<ButtonVariant, CSSProperties> = {
  primary: { background: colors.blue, color: "#fff" },
  accent: { background: colors.yellow, color: colors.navy },
  success: { background: colors.green, color: "#fff" },
  danger: { background: colors.red, color: "#fff" },
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
        fontSize: size === "sm" ? 13 : 14,
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
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {dot && <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot }} />}
      {children}
    </span>
  );
}

export function TripStatusBadge({ status }: { status: string }) {
  const c = tripStatusColor[status] ?? tripStatusColor.pending;
  return (
    <Pill bg={c.bg} fg={c.fg} border={c.border} dot={c.dot}>
      {tripStatusLabel[status] ?? status}
    </Pill>
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
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 13px",
              borderRadius: radius.md,
              border: `1px solid ${active ? colors.blue : colors.border}`,
              background: active ? colors.blue : colors.card,
              color: active ? "#fff" : colors.textMuted,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
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
                  fontSize: 11.5,
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
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(16,24,40,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: colors.card,
          borderRadius: radius.lg,
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
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
          <button
            onClick={onClose}
            style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 20, color: colors.textMuted, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
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
      <div style={{ fontSize: 13.5, color: colors.text, lineHeight: 1.6, marginBottom: 14 }}>
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
      {label && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: colors.text }}>{label}</div>}
      <input
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
      <div style={{ fontSize: 13 }}>{label}</div>
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
