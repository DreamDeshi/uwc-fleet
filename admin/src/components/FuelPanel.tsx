import { useMemo, useState } from "react";
import { useFuelSummary, useLogFuel, useTruckFuel, useTrucks } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, EmptyState, ErrorState, Loading, Modal } from "@/components/ui";
import { apiErrorMessage } from "@/services/api";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import type { TruckFuelSummary } from "@/types";

// FR-CT5 — fuel cost tracking. This-month spend per truck, with each row
// expandable to its individual fill-up logs, plus an admin "Log Fuel" form.
export function FuelPanel() {
  const summary = useFuelSummary();
  const [logOpen, setLogOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const monthTotal = useMemo(
    () => (summary.data ?? []).reduce((s, r) => s + r.total_cost_rm, 0),
    [summary.data]
  );

  if (summary.isLoading) return <Loading />;
  if (summary.isError)
    return <ErrorState message="Could not load fuel data." onRetry={() => summary.refetch()} />;

  const rows = summary.data ?? [];

  return (
    <>
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 16px",
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: colors.text }}>Fuel — This Month</div>
            <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 2 }}>
              Total spend {formatMoney(monthTotal)} across {rows.length} truck{rows.length === 1 ? "" : "s"}
            </div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <Button size="sm" onClick={() => setLogOpen(true)}>
              + Log Fuel
            </Button>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyState message="No fuel logged this month yet." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ background: colors.panel, color: colors.textMuted, textAlign: "left" }}>
                <Th>Truck</Th>
                <Th>Type</Th>
                <Th align="right">Litres</Th>
                <Th align="right">Cost (RM)</Th>
                <Th align="right">Cost / km</Th>
                <Th align="right"></Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <FuelRow
                  key={r.plate}
                  row={r}
                  expanded={expanded === r.plate}
                  onToggle={() => setExpanded((p) => (p === r.plate ? null : r.plate))}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <LogFuelModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      style={{
        padding: "10px 16px",
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        textAlign: align,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return <td style={{ padding: "11px 16px", textAlign: align, color: colors.text }}>{children}</td>;
}

function FuelRow({
  row,
  expanded,
  onToggle,
}: {
  row: TruckFuelSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          borderTop: `1px solid ${colors.divider}`,
          cursor: "pointer",
          background: expanded ? colors.blueTint : undefined,
        }}
      >
        <Td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: colors.textFaint, fontSize: 12 }}>{expanded ? "▾" : "▸"}</span>
            <span style={{ fontWeight: 800, letterSpacing: 0.3 }}>{row.plate}</span>
          </span>
        </Td>
        <Td>
          <span style={{ color: colors.textMuted }}>{row.type}</span>
        </Td>
        <Td align="right">{formatNumber(row.total_litres)} L</Td>
        <Td align="right">{formatMoney(row.total_cost_rm)}</Td>
        <Td align="right">{row.cost_per_km != null ? formatMoney(row.cost_per_km) : "—"}</Td>
        <Td align="right">
          <span style={{ fontSize: 13, color: colors.textFaint }}>
            {row.log_count} fill{row.log_count === 1 ? "" : "s"}
          </span>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ background: colors.panel, padding: 0 }}>
            <ExpandedLogs plate={row.plate} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedLogs({ plate }: { plate: string }) {
  const fuel = useTruckFuel(plate);

  if (fuel.isLoading)
    return <div style={{ padding: 16, fontSize: 14, color: colors.textMuted }}>Loading logs…</div>;
  if (fuel.isError)
    return <div style={{ padding: 16, fontSize: 14, color: colors.red }}>Could not load logs.</div>;

  const logs = fuel.data?.logs ?? [];
  const s = fuel.data?.summary;

  if (logs.length === 0)
    return <div style={{ padding: 16, fontSize: 14, color: colors.textMuted }}>No fill-ups recorded.</div>;

  return (
    <div style={{ padding: "8px 16px 14px" }}>
      {s && (
        <div style={{ fontSize: 13, color: colors.textMuted, margin: "6px 0 10px" }}>
          All-time: {formatNumber(s.total_litres)} L · {formatMoney(s.total_cost_rm)} ·{" "}
          {s.avg_cost_per_litre != null ? `${formatMoney(s.avg_cost_per_litre)}/L` : "—/L"} ·{" "}
          {s.total_km_covered > 0 ? `${formatNumber(s.total_km_covered)} km` : "— km"}
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: colors.textFaint, textAlign: "left" }}>
            <Th>Date</Th>
            <Th align="right">Litres</Th>
            <Th align="right">Cost</Th>
            <Th align="right">Odometer</Th>
            <Th>Logged by</Th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} style={{ borderTop: `1px solid ${colors.divider}` }}>
              <Td>{formatDate(l.logged_at)}</Td>
              <Td align="right">{formatNumber(l.liters)} L</Td>
              <Td align="right">{formatMoney(l.cost)}</Td>
              <Td align="right">{l.odometer != null ? `${formatNumber(l.odometer)} km` : "—"}</Td>
              <Td>
                <span style={{ color: colors.textMuted }}>{l.driver?.name ?? "—"}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Log Fuel form (admin) ────────────────────────────────────────────────
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function LogFuelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trucks = useTrucks();
  const logFuel = useLogFuel();
  const [plate, setPlate] = useState("");
  const [litres, setLitres] = useState("");
  const [cost, setCost] = useState("");
  const [odometer, setOdometer] = useState("");
  const [date, setDate] = useState(todayIso);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPlate("");
    setLitres("");
    setCost("");
    setOdometer("");
    setDate(todayIso());
    setError(null);
  };

  const submit = () => {
    setError(null);
    const litresN = Number(litres);
    const costN = Number(cost);
    const odoN = Number(odometer);
    if (!plate) return setError("Please select a truck.");
    if (!(litresN > 0)) return setError("Litres must be a positive number.");
    if (!(costN > 0)) return setError("Cost (RM) must be a positive number.");
    if (!(odoN > 0)) return setError("Odometer (km) must be a positive number.");

    logFuel.mutate(
      { plate, litres: litresN, cost_rm: costN, odometer_km: odoN, logged_at: date },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
        onError: (err) => setError(apiErrorMessage(err, "Could not save the fuel log.")),
      }
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Log Fuel Fill-up" width={420}>
      <label style={{ display: "block", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>Truck</div>
        <select
          value={plate}
          onChange={(e) => setPlate(e.target.value)}
          style={{
            width: "100%",
            padding: "11px 13px",
            borderRadius: radius.md,
            border: `1px solid ${colors.border}`,
            fontSize: 14,
            outline: "none",
            color: colors.text,
            background: colors.card,
          }}
        >
          <option value="">Select a truck…</option>
          {(trucks.data ?? []).map((t) => (
            <option key={t.plate} value={t.plate}>
              {t.plate} — {t.type}
            </option>
          ))}
        </select>
      </label>

      <NumberInput label="Litres" value={litres} onChange={setLitres} placeholder="e.g. 120.5" />
      <NumberInput label="Cost (RM)" value={cost} onChange={setCost} placeholder="e.g. 380.00" />
      <NumberInput label="Odometer (km)" value={odometer} onChange={setOdometer} placeholder="e.g. 152340" />

      <label style={{ display: "block", marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>Date</div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
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

      {error && <div style={{ color: colors.red, fontSize: 14, marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <Button variant="ghost" onClick={onClose} full>
          Cancel
        </Button>
        <Button onClick={submit} disabled={logFuel.isPending} full>
          {logFuel.isPending ? "Saving…" : "Save Log"}
        </Button>
      </div>
    </Modal>
  );
}

// Numeric text input — uses inputMode for a numeric keypad without forcing the
// browser's spinner/step behaviour (lets users type decimals like "120.5").
function NumberInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: colors.text }}>{label}</div>
      <input
        inputMode="decimal"
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
