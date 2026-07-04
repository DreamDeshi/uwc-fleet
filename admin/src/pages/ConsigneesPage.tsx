import { useEffect, useState } from "react";
import { useConsignees, useUpdateConsignee } from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { Button, Card, EmptyState, ErrorState, Loading, Modal, Pill, SearchInput } from "@/components/ui";
import { apiErrorMessage } from "@/services/api";
import { ZONES } from "@/lib/zones";
import type { Consignee } from "@/types";

// ── Consignee directory management ─────────────────────────────────────
// The correction path for wrong-zone self-adds (audit part A): a requestor's
// mis-zoned consignee used to be permanent — every future booking to it
// mis-dispatched and mispaid. Admin can now fix the zone, rename, or
// deactivate (deactivated consignees can't be booked; reactivate via the
// "include deactivated" toggle). Corrections affect FUTURE bookings only —
// past pay is protected by the assignment/finalization snapshots.
export function ConsigneesPage() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<Consignee | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const consignees = useConsignees(debouncedQ, includeInactive);

  if (consignees.isLoading) return <Loading />;
  if (consignees.isError)
    return <ErrorState message="Could not load consignees." onRetry={() => consignees.refetch()} />;

  const rows = consignees.data ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card pad={12} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SearchInput value={q} onChange={setQ} placeholder="Search company, area, state…" />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: colors.textMuted, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Include deactivated
        </label>
        <span style={{ fontSize: 12, color: colors.textFaint }}>
          Showing {rows.length} result{rows.length === 1 ? "" : "s"} (max 10 — refine the search)
        </span>
      </Card>

      <Card pad={0}>
        {rows.length === 0 ? (
          <EmptyState message="No consignees match this search." />
        ) : (
          <div>
            {rows.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  borderBottom: `1px solid ${colors.divider}`,
                  opacity: c.is_active === false ? 0.55 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: colors.text }}>
                    {c.company_name}
                    {c.is_active === false && (
                      <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: colors.red }}>
                        DEACTIVATED
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
                    {[c.area, c.state].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <Pill bg={colors.blueTint} fg={colors.blue}>
                  {c.zone_code}
                </Pill>
                <Button size="sm" variant="outline" onClick={() => setEditing(c)}>
                  Edit
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && <EditConsigneeModal consignee={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EditConsigneeModal({ consignee, onClose }: { consignee: Consignee; onClose: () => void }) {
  const update = useUpdateConsignee();
  // Edit the FULL legal name — company_name in the list payload is
  // display-stripped ("SDN BHD" removed) and must not be written back.
  const [name, setName] = useState(consignee.company_name_full ?? consignee.company_name);
  const [zone, setZone] = useState(consignee.zone_code);
  const [active, setActive] = useState(consignee.is_active !== false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    try {
      await update.mutateAsync({
        id: consignee.id,
        company_name: name.trim() || undefined,
        zone_code: zone,
        is_active: active,
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, "Could not save. Try again."));
    }
  };

  const zoneChanged = zone !== consignee.zone_code;

  return (
    <Modal open title="Edit Consignee" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label style={fieldLabel}>
          Company name
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldLabel}>
          Delivery zone
          <select value={zone} onChange={(e) => setZone(e.target.value)} style={inputStyle}>
            {ZONES.map((z) => (
              <option key={z.code} value={z.code}>
                {z.code} — {z.name}
              </option>
            ))}
          </select>
        </label>
        {zoneChanged && (
          <div style={{ fontSize: 12, color: colors.orange, background: colors.orangeTint, borderRadius: radius.sm, padding: "8px 10px" }}>
            Zone changes apply to FUTURE bookings only — completed trips keep the
            pay they were finalized at (snapshotted), and the change is audit-logged.
          </div>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: colors.text, cursor: "pointer" }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (bookable by requestors)
        </label>
        {error && <div style={{ color: colors.red, fontSize: 12.5, fontWeight: 600 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 12,
  fontWeight: 700,
  color: colors.textMuted,
};
const inputStyle: React.CSSProperties = {
  height: 38,
  borderRadius: radius.sm,
  border: `1px solid ${colors.border}`,
  padding: "0 10px",
  fontSize: 13.5,
  color: colors.text,
  background: colors.card,
};
