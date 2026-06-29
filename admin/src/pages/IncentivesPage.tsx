import { useMemo, useState } from "react";
import { useDestinationRates, useRateAudit, useTrucks, useUpdateDestinationRate, useUpdateTruckRates } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, ErrorState, Input, Loading, Modal, Pill, SectionTitle } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { apiErrorMessage } from "@/services/api";
import type { DestinationRate, RateAuditEntry, Truck } from "@/types";

// Small muted "last updated by X on DATE" line, shown under a row when the audit
// log has a record for it. Kept compact so it never crowds the rate values.
function UpdatedNote({ entry }: { entry?: RateAuditEntry }) {
  if (!entry) return null;
  return (
    <div style={{ fontSize: 11, color: colors.textFaint, marginTop: 3 }}>
      Updated by {entry.user_name} · {formatDate(entry.timestamp)}
    </div>
  );
}

type Tab = "trucks" | "destinations" | "formula";

export function IncentivesPage() {
  const [tab, setTab] = useState<Tab>("trucks");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {([["trucks", "Truck Claim Rates"], ["destinations", "Destination Points"], ["formula", "Formula & Examples"]] as const).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setTab(v)}
            style={{
              padding: "9px 16px",
              borderRadius: radius.md,
              border: `1px solid ${tab === v ? colors.blue : colors.border}`,
              background: tab === v ? colors.blue : colors.card,
              color: tab === v ? "#fff" : colors.textMuted,
              fontWeight: 700,
              fontSize: 13.5,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ background: colors.blueTint, borderRadius: radius.md, padding: "11px 15px", fontSize: 12.5, color: colors.blue, fontWeight: 500 }}>
        Every rate change is recorded in the audit log. Source of truth: UWC Internal Lorry Rate (Development Brief §3).
      </div>

      {tab === "trucks" && <TruckRatesTab />}
      {tab === "destinations" && <DestinationPointsTab />}
      {tab === "formula" && <FormulaTab />}
    </div>
  );
}

// ── Truck claim rates ─────────────────────────────────────────────────
function TruckRatesTab() {
  const trucks = useTrucks();
  const audit = useRateAudit();
  const [editing, setEditing] = useState<Truck | null>(null);

  const auditByPlate = useMemo(() => {
    const m = new Map<string, RateAuditEntry>();
    for (const a of audit.data ?? []) if (a.table_name === "Truck") m.set(a.record_id, a);
    return m;
  }, [audit.data]);

  if (trucks.isLoading) return <Loading />;
  if (trucks.isError) return <ErrorState message="Could not load trucks." onRetry={() => trucks.refetch()} />;

  return (
    <Card pad={0}>
      <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
        <SectionTitle title="Entitled Claim Rates per Truck" subtitle={`${trucks.data!.length} trucks`} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Truck", "Type", "Max Load", "Weekday Rate", "Weekend Rate", "Daily Deduction", ""].map((h) => (
              <th key={h} style={thStyle}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trucks.data!.map((t, i) => (
            <tr key={t.plate} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
              <td style={{ ...tdStyle, fontWeight: 700 }}>
                {t.plate}
                <UpdatedNote entry={auditByPlate.get(t.plate)} />
              </td>
              <td style={tdStyle}>{t.type}</td>
              <td style={tdStyle}>{t.max_pallets} pallets</td>
              <td style={tdStyle}><Pill bg={colors.blueTint} fg={colors.blue}>{formatMoney(t.entitled_claim_weekday)}</Pill></td>
              <td style={tdStyle}><Pill bg={colors.yellowTint} fg={colors.amber}>{formatMoney(t.entitled_claim_offpeak)}</Pill></td>
              <td style={tdStyle}><Pill bg={colors.redTint} fg={colors.red}>{t.daily_deduction_points} pts</Pill></td>
              <td style={tdStyle}>
                <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>Edit</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && <EditTruckModal truck={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function EditTruckModal({ truck, onClose }: { truck: Truck; onClose: () => void }) {
  const [weekday, setWeekday] = useState(String(truck.entitled_claim_weekday));
  const [weekend, setWeekend] = useState(String(truck.entitled_claim_offpeak));
  const [deduction, setDeduction] = useState(String(truck.daily_deduction_points));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateTruckRates();

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        plate: truck.plate,
        entitled_claim_weekday: Number(weekday),
        entitled_claim_offpeak: Number(weekend),
        daily_deduction_points: Number(deduction),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not update rates."));
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit Rates — ${truck.plate}`}>
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
      <Input label="Weekday Rate (RM)" value={weekday} onChange={setWeekday} type="number" />
      <Input label="Weekend / Holiday Rate (RM)" value={weekend} onChange={setWeekend} type="number" />
      <Input label="Daily Deduction (points)" value={deduction} onChange={setDeduction} type="number" />
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <Button variant="ghost" full onClick={onClose}>Cancel</Button>
        <Button variant="primary" full disabled={update.isPending} onClick={save}>{update.isPending ? "Saving…" : "Save Changes"}</Button>
      </div>
    </Modal>
  );
}

// ── Destination points ────────────────────────────────────────────────
const MAX_POINTS = 8;
function tier(points: number) {
  if (points <= 1) return { label: "Local", color: colors.green };
  if (points <= 3) return { label: "Nearby", color: colors.blue };
  if (points <= 5) return { label: "Medium", color: colors.amber };
  if (points <= 6) return { label: "Far", color: colors.orange };
  return { label: "Long Distance", color: colors.red };
}

function DestinationPointsTab() {
  const rates = useDestinationRates();
  const audit = useRateAudit();
  const [editing, setEditing] = useState<DestinationRate | null>(null);

  const auditById = useMemo(() => {
    const m = new Map<string, RateAuditEntry>();
    for (const a of audit.data ?? []) if (a.table_name === "DestinationRate") m.set(a.record_id, a);
    return m;
  }, [audit.data]);

  if (rates.isLoading) return <Loading />;
  if (rates.isError) return <ErrorState message="Could not load destination rates." onRetry={() => rates.refetch()} />;

  return (
    <Card pad={0}>
      <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
        <SectionTitle title="Destination Point Values" subtitle={`${rates.data!.length} destinations · first-trip-of-day points`} />
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Destination", "Zone", "Points", "Tier", ""].map((h) => <th key={h} style={thStyle}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rates.data!.map((r, i) => {
            const ti = tier(r.points);
            return (
              <tr key={r.id} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>
                  {r.location_name}
                  <UpdatedNote entry={auditById.get(r.id)} />
                </td>
                <td style={tdStyle}>{r.zone_code ?? "—"}</td>
                <td style={{ ...tdStyle, minWidth: 160 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ flex: 1, maxWidth: 90, height: 8, background: colors.divider, borderRadius: 999, overflow: "hidden" }}>
                      <div style={{ width: `${(r.points / MAX_POINTS) * 100}%`, height: "100%", background: ti.color }} />
                    </div>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{r.points}</span>
                  </div>
                </td>
                <td style={tdStyle}><Pill bg={`${ti.color}1a`} fg={ti.color}>{ti.label}</Pill></td>
                <td style={tdStyle}><Button variant="ghost" size="sm" onClick={() => setEditing(r)}>Edit</Button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editing && <EditPointsModal rate={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function EditPointsModal({ rate, onClose }: { rate: DestinationRate; onClose: () => void }) {
  const [points, setPoints] = useState(String(rate.points));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateDestinationRate();

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: rate.id, points: Number(points) });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not update points."));
    }
  }

  return (
    <Modal open onClose={onClose} title={`Edit Points — ${rate.location_name}`} width={380}>
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
      <Input label="Destination Points" value={points} onChange={setPoints} type="number" />
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <Button variant="ghost" full onClick={onClose}>Cancel</Button>
        <Button variant="primary" full disabled={update.isPending} onClick={save}>{update.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </Modal>
  );
}

// ── Formula explainer ─────────────────────────────────────────────────
function FormulaTab() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: `linear-gradient(135deg, ${colors.blue}, #001a4d)`, borderRadius: radius.lg, padding: 26, color: "#fff", textAlign: "center" }}>
        <div style={{ fontSize: 12, letterSpacing: 1, opacity: 0.7, textTransform: "uppercase", marginBottom: 10 }}>Incentive Formula</div>
        <div style={{ fontSize: 19, fontWeight: 700 }}>
          Entitled Claim Rate (RM) × <span style={{ color: colors.yellow }}>Destination Points</span>
        </div>
        <div style={{ fontSize: 14, marginTop: 8, opacity: 0.85 }}>
          then subtract <span style={{ color: colors.yellow, fontWeight: 700 }}>Daily Deduction Points</span> on the first trip of the day
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Card>
          <SectionTitle title="Calculation Rules" />
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: colors.text, lineHeight: 1.9 }}>
            <li>Each truck has its own weekday and weekend/holiday claim rate.</li>
            <li>Destination points reflect distance — further zones earn more.</li>
            <li>Weekend &amp; public-holiday trips use the higher off-peak rate.</li>
            <li>The daily deduction applies once, on the first trip of the day.</li>
            <li>Subsequent same-day trips are not deducted again.</li>
            <li>All amounts are computed server-side by the incentive engine.</li>
          </ul>
        </Card>
        <Card>
          <SectionTitle title="Time-Based Rates" />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ background: colors.blueTint, borderRadius: radius.md, padding: 14 }}>
              <div style={{ fontSize: 12, color: colors.blue, fontWeight: 700, textTransform: "uppercase" }}>Weekday — Standard Rate</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>Mon–Fri, normal operating window 07:00–18:00.</div>
            </div>
            <div style={{ background: colors.yellowTint, borderRadius: radius.md, padding: 14 }}>
              <div style={{ fontSize: 12, color: colors.amber, fontWeight: 700, textTransform: "uppercase" }}>Weekend / Holiday — Higher Rate</div>
              <div style={{ fontSize: 13, color: colors.textMuted, marginTop: 4 }}>Saturdays, Sundays &amp; Malaysian public holidays.</div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: colors.textMuted,
  padding: "12px 16px",
  borderBottom: `1px solid ${colors.border}`,
  background: colors.panel,
};
const tdStyle: React.CSSProperties = {
  fontSize: 13,
  color: colors.text,
  padding: "12px 16px",
  borderBottom: `1px solid ${colors.divider}`,
};
