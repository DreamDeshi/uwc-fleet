import { useMemo, useState } from "react";
import { useAddHoliday, useDeleteHoliday, useDestinationRates, useHolidays, useRateAudit, useResetTruckRates, useTrucks, useUpdateDestinationRate, useUpdateTruckRates } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, ErrorState, Input, Loading, Modal, Pill, SectionTitle } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { apiErrorMessage } from "@/services/api";
import type { DestinationRate, PublicHoliday, RateAuditEntry, RateResetResult, Truck } from "@/types";

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

// A staged rate edit waiting for its next-MYT-day cutoff: today's assignments
// still pay the current (displayed) rates; these values take over on the date.
function PendingRatesNote({ pending }: { pending: Truck["pending_rates"] }) {
  if (!pending) return null;
  const parts: string[] = [];
  if (pending.entitled_claim_weekday !== null) parts.push(`weekday ${formatMoney(pending.entitled_claim_weekday)}`);
  if (pending.entitled_claim_offpeak !== null) parts.push(`weekend ${formatMoney(pending.entitled_claim_offpeak)}`);
  if (pending.daily_deduction_points !== null) parts.push(`deduction ${pending.daily_deduction_points} pts`);
  return (
    <div style={{ fontSize: 11, color: colors.amber, fontWeight: 600, marginTop: 3 }}>
      ⏳ New rates {parts.join(" · ")} — take effect {pending.effective_date} (MYT)
    </div>
  );
}

type Tab = "trucks" | "destinations" | "holidays" | "formula";

export function IncentivesPage() {
  const [tab, setTab] = useState<Tab>("trucks");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {([["trucks", "Truck Claim Rates"], ["destinations", "Destination Points"], ["holidays", "Public Holidays"], ["formula", "Formula & Examples"]] as const).map(([v, label]) => (
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
      {tab === "holidays" && <HolidaysTab />}
      {tab === "formula" && <FormulaTab />}
    </div>
  );
}

// ── Truck claim rates ─────────────────────────────────────────────────
function TruckRatesTab() {
  const trucks = useTrucks();
  const audit = useRateAudit();
  const [editing, setEditing] = useState<Truck | null>(null);
  // "Reset to UWC spec defaults" — confirm dialog + last result summary.
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetResult, setResetResult] = useState<RateResetResult | null>(null);

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
        <SectionTitle
          title="Entitled Claim Rates per Truck"
          subtitle={`${trucks.data!.length} trucks`}
          right={
            <Button variant="outline" size="sm" onClick={() => setConfirmingReset(true)}>
              ↺ Reset to UWC spec defaults
            </Button>
          }
        />
        {resetResult && <ResetResultBanner result={resetResult} onDismiss={() => setResetResult(null)} />}
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
                <PendingRatesNote pending={t.pending_rates} />
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
      {confirmingReset && (
        <ResetRatesConfirm
          onClose={() => setConfirmingReset(false)}
          onDone={(r) => {
            setResetResult(r);
            setConfirmingReset(false);
          }}
        />
      )}
    </Card>
  );
}

// Confirm dialog for the spec reset. Overwrites all truck rate values, so it
// asks before firing (Cancel / Reset).
function ResetRatesConfirm({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (r: RateResetResult) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const reset = useResetTruckRates();

  async function doReset() {
    setError(null);
    try {
      onDone(await reset.mutateAsync());
    } catch (e) {
      setError(apiErrorMessage(e, "Could not reset rates."));
    }
  }

  return (
    <Modal open onClose={onClose} title="Reset truck rates to UWC spec?" width={420}>
      {error && (
        <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div style={{ fontSize: 13.5, color: colors.text, lineHeight: 1.6, marginBottom: 14 }}>
        Reset all truck rates to UWC spec defaults? This overwrites current rate values
        (weekday &amp; weekend claim, daily deduction, max load) for all trucks with the
        authoritative values from <code>docs/uwc-spec.json</code>. Audit-logged.
        Rate values take effect <strong>tomorrow (MYT)</strong>; max load applies immediately.
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="ghost" full onClick={onClose} disabled={reset.isPending}>Cancel</Button>
        <Button variant="danger" full onClick={doReset} disabled={reset.isPending}>
          {reset.isPending ? "Resetting…" : "Reset"}
        </Button>
      </div>
    </Modal>
  );
}

// Brief result summary after a reset (e.g. "3 trucks reset · 4 already at spec").
function ResetResultBanner({ result, onDismiss }: { result: RateResetResult; onDismiss: () => void }) {
  const parts = [
    `${result.updated.length} truck${result.updated.length === 1 ? "" : "s"} reset`,
    `${result.already_at_spec.length} already at spec`,
  ];
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped (not in DB)`);
  if (result.updated.length > 0 && result.rates_effective_date) {
    parts.push(`rates take effect ${result.rates_effective_date} (MYT)`);
  }
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 12, background: colors.greenTint, color: colors.green, borderRadius: radius.md, padding: "9px 13px", fontSize: 12.5, fontWeight: 600 }}>
      <span>✓ {parts.join(" · ")}</span>
      <button onClick={onDismiss} style={{ background: "none", border: "none", color: colors.green, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>×</button>
    </div>
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
      <div style={{ background: colors.yellowTint, color: colors.amber, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12, fontWeight: 500 }}>
        Rate changes take effect <strong>tomorrow (MYT)</strong> — today's assignments and
        running trips keep today's rates.
      </div>
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

// ── Public holidays ───────────────────────────────────────────────────
// Admin-managed calendar that drives the weekday/off-peak rate decision (the
// engine holds no baked-in list). Money-affecting either way, so deleting asks
// for confirmation and every change is audit-logged server-side.
function HolidaysTab() {
  const holidays = useHolidays();
  const [deleting, setDeleting] = useState<PublicHoliday | null>(null);

  if (holidays.isLoading) return <Loading />;
  if (holidays.isError) return <ErrorState message="Could not load the holiday calendar." onRetry={() => holidays.refetch()} />;

  const rows = holidays.data!;
  const weekdayName = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString("en-MY", { weekday: "long", timeZone: "UTC" });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ background: colors.yellowTint, borderRadius: radius.md, padding: "11px 15px", fontSize: 12.5, color: colors.amber, fontWeight: 500 }}>
        Trips picked up on a listed date pay the off-peak rate all day. Islamic holiday
        dates are moon-sighting estimates — verify against the official JPA/JAKIM gazette.
      </div>
      <AddHolidayForm />
      <Card pad={0}>
        <div style={{ padding: 18, borderBottom: `1px solid ${colors.border}` }}>
          <SectionTitle title="Public Holiday Calendar" subtitle={`${rows.length} dates`} />
        </div>
        {rows.length === 0 ? (
          <div style={{ padding: 24, fontSize: 13, color: colors.textMuted }}>
            No holidays in the calendar — every weekday pays the weekday rate until dates are added.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>{["Date", "Day", "Holiday", ""].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((h, i) => (
                <tr key={h.id} style={{ background: i % 2 ? colors.blueTint : "transparent" }}>
                  <td style={{ ...tdStyle, fontWeight: 700, whiteSpace: "nowrap" }}>{h.date}</td>
                  <td style={tdStyle}>{weekdayName(h.date)}</td>
                  <td style={tdStyle}>{h.name}</td>
                  <td style={{ ...tdStyle, textAlign: "right" }}>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(h)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {deleting && <DeleteHolidayConfirm holiday={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function AddHolidayForm() {
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useAddHoliday();

  async function submit() {
    setError(null);
    if (!date || !name.trim()) {
      setError("Both the date and the holiday name are required.");
      return;
    }
    try {
      await add.mutateAsync({ date, name: name.trim() });
      setDate("");
      setName("");
    } catch (e) {
      setError(apiErrorMessage(e, "Could not add the holiday."));
    }
  }

  return (
    <Card>
      <SectionTitle title="Add a Holiday" />
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
        <div style={{ width: 190 }}>
          <Input label="Date" value={date} onChange={setDate} type="date" />
        </div>
        <div style={{ flex: 1 }}>
          <Input label="Holiday name" value={name} onChange={setName} placeholder="e.g. Nuzul Al-Quran" />
        </div>
        <Button variant="primary" onClick={submit} disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </Card>
  );
}

// Removing a holiday flips that date's not-yet-finalized trips back to the
// weekday rate — ask before firing. Completed trips keep their stored pay.
function DeleteHolidayConfirm({ holiday, onClose }: { holiday: PublicHoliday; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const del = useDeleteHoliday();

  async function doDelete() {
    setError(null);
    try {
      await del.mutateAsync(holiday.id);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not remove the holiday."));
    }
  }

  return (
    <Modal open onClose={onClose} title="Remove this holiday?" width={420}>
      {error && <div style={{ background: colors.redTint, color: colors.red, borderRadius: radius.md, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{error}</div>}
      <div style={{ fontSize: 13.5, color: colors.text, lineHeight: 1.6, marginBottom: 14 }}>
        Remove <strong>{holiday.name}</strong> ({holiday.date}) from the calendar? Trips picked
        up that day will pay the normal weekday rate instead of the off-peak rate.
        Already-completed trips keep their finalized pay. Audit-logged.
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <Button variant="ghost" full onClick={onClose} disabled={del.isPending}>Cancel</Button>
        <Button variant="danger" full onClick={doDelete} disabled={del.isPending}>
          {del.isPending ? "Removing…" : "Remove"}
        </Button>
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
