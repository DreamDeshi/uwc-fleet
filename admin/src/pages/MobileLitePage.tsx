import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  useDashboard,
  useTrips,
  useDrivers,
  usePendingUsers,
  useApproveTrip,
  useRejectTrip,
  useApproveUser,
} from "@/hooks/queries";
import { colors, radius } from "@/theme";
import { apiErrorMessage } from "@/services/api";
import { Button, Pill, Avatar, TripStatusBadge, Loading, ErrorState, EmptyState } from "@/components/ui";
import { ORIGIN_LABEL, tripDestination, totalPallets, cargoSummary } from "@/lib/trip";
import { initials } from "@/lib/format";
import type { Trip, DriverPerf, AdminUser } from "@/types";

// ── Admin "lite" — the away-from-desk mobile screen ──────────────────────
// Covers only the two time-sensitive actions an admin needs on a phone:
// dispatch a pending booking (assign driver / reject) and approve new users.
// Everything else (rate editing, reports, truck docs) stays on the desktop app.
export function MobileLitePage() {
  const { user, logout } = useAuth();
  const dash = useDashboard();
  const trips = useTrips();
  const drivers = useDrivers();
  const pendingUsers = usePendingUsers();

  const pendingTrips = (trips.data ?? []).filter((t) => t.status === "pending");

  return (
    <div style={{ minHeight: "100%", background: colors.bg }}>
      {/* App bar */}
      <header style={styles.appbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={styles.logo}>
            <svg width="20" height="14" viewBox="0 0 22 15" fill="none">
              <rect x="0" y="4" width="14" height="9" rx="2" fill={colors.blue} />
              <rect x="14" y="6" width="8" height="7" rx="2" fill={colors.blue} />
              <circle cx="4" cy="13" r="2" fill={colors.blue} />
              <circle cx="18" cy="13" r="2" fill={colors.blue} />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>UWC Admin</div>
            <div style={{ fontSize: 10, color: colors.yellow, fontWeight: 700, letterSpacing: 1 }}>MOBILE</div>
          </div>
        </div>
        <button onClick={logout} style={styles.signOut}>
          Sign Out
        </button>
      </header>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 18, maxWidth: 640, margin: "0 auto" }}>
        {/* Status header */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          <StatTile label="Pending" value={dash.data?.pending_trips ?? pendingTrips.length} tone={colors.orange} />
          <StatTile label="Active Trucks" value={dash.data?.active_trucks ?? "—"} tone={colors.green} />
          <StatTile label="Alerts" value={dash.data?.alerts ?? 0} tone={colors.red} />
        </div>

        {/* Pending dispatch */}
        <section>
          <h2 style={styles.h2}>
            Pending Dispatch
            {pendingTrips.length > 0 && <span style={styles.countDot}>{pendingTrips.length}</span>}
          </h2>
          {trips.isLoading ? (
            <Loading />
          ) : trips.isError ? (
            <ErrorState message="Could not load trips." onRetry={() => trips.refetch()} />
          ) : pendingTrips.length === 0 ? (
            <EmptyState message="No bookings waiting for dispatch." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {pendingTrips.map((trip) => (
                <DispatchCard key={trip.id} trip={trip} drivers={drivers.data ?? []} />
              ))}
            </div>
          )}
        </section>

        {/* User approvals */}
        <section>
          <h2 style={styles.h2}>
            User Approvals
            {(pendingUsers.data?.length ?? 0) > 0 && <span style={styles.countDot}>{pendingUsers.data!.length}</span>}
          </h2>
          {pendingUsers.isLoading ? (
            <Loading />
          ) : pendingUsers.isError ? (
            <ErrorState message="Could not load approvals." onRetry={() => pendingUsers.refetch()} />
          ) : (pendingUsers.data?.length ?? 0) === 0 ? (
            <EmptyState message="The approval queue is empty." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {pendingUsers.data!.map((u) => (
                <ApprovalCard key={u.id} user={u} />
              ))}
            </div>
          )}
        </section>

        <div style={{ textAlign: "center", fontSize: 11.5, color: colors.textFaint, paddingBottom: 8 }}>
          Signed in as {user?.name ?? "Admin"} · Full tools on the desktop dashboard
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radius.md, padding: "12px 10px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 5 }}>
        {label}
      </div>
    </div>
  );
}

// One pending booking: shows route + cargo, expands to a fitting-driver picker.
function DispatchCard({ trip, drivers }: { trip: Trip; drivers: DriverPerf[] }) {
  const approve = useApproveTrip();
  const reject = useRejectTrip();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pallets = totalPallets(trip);

  // Available drivers (have a truck, off a trip), fitting ones first.
  const remainingFor = (d: DriverPerf) =>
    d.assigned_truck ? d.assigned_truck.max_pallets - d.current_load : 0;
  // Available drivers (have a truck, off a trip), those with room first.
  const available = drivers
    .filter((d) => d.status === "available" && d.assigned_truck)
    .sort((a, b) => Number(remainingFor(b) >= pallets) - Number(remainingFor(a) >= pallets));

  const assign = async (driverId: string, plate: string) => {
    setError(null);
    try {
      await approve.mutateAsync({ id: trip.id, driver_id: driverId, truck_plate: plate });
    } catch (e) {
      // Surface the server's specific block (driver on leave, truck overloaded,
      // scheduling conflict, …) — a generic "try again" invites retrying an
      // assignment that can never succeed.
      setError(apiErrorMessage(e, "Could not assign. Try again."));
    }
  };

  const onReject = async () => {
    if (!window.confirm(`Reject booking ${trip.ticket_number}?`)) return;
    setError(null);
    try {
      await reject.mutateAsync({ id: trip.id });
    } catch (e) {
      setError(apiErrorMessage(e, "Could not reject. Try again."));
    }
  };

  const busy = approve.isPending || reject.isPending;

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radius.lg, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ fontWeight: 800, color: colors.blue, fontSize: 13 }}>{trip.ticket_number}</div>
        <TripStatusBadge status={trip.status} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, marginTop: 8 }}>
        {ORIGIN_LABEL} → {tripDestination(trip)}
      </div>
      <div style={{ fontSize: 12.5, color: colors.textMuted, marginTop: 4 }}>
        {cargoSummary(trip)} · {pallets} pallet{pallets === 1 ? "" : "s"}
      </div>

      {!open ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Button size="sm" full onClick={() => setOpen(true)}>
            Assign driver
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={busy} style={{ color: colors.red }}>
            Reject
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11.5, color: colors.textMuted, marginBottom: 8 }}>
            Drivers with capacity ≥ {pallets} pallets can take this trip.
          </div>
          {available.length === 0 ? (
            <div style={{ fontSize: 13, color: colors.textMuted, padding: "6px 0" }}>No available drivers right now.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {available.map((d) => {
                const fits = remainingFor(d) >= pallets;
                return (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <Avatar name={d.name} size={34} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: colors.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {d.name}
                      </div>
                      <div style={{ fontSize: 11.5, color: colors.textMuted }}>
                        {d.assigned_truck!.plate} · {d.current_load}/{d.assigned_truck!.max_pallets}p
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={fits ? "success" : "ghost"}
                      disabled={!fits || busy}
                      onClick={() => assign(d.id, d.assigned_truck!.plate)}
                    >
                      {fits ? "Assign" : d.current_load > 0 ? "No room" : "Too small"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          <Button size="sm" variant="outline" full style={{ marginTop: 10 }} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      )}

      {error && <div style={{ color: colors.red, fontSize: 12.5, fontWeight: 600, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function ApprovalCard({ user }: { user: AdminUser }) {
  const approveUser = useApproveUser();
  const [error, setError] = useState<string | null>(null);
  const roleTone =
    user.role === "driver"
      ? { bg: colors.blueTint, fg: colors.blue }
      : user.role === "requestor"
        ? { bg: colors.greenTint, fg: colors.green }
        : { bg: colors.panel, fg: colors.navy };

  const decide = async (status: "active" | "disabled") => {
    setError(null);
    try {
      await approveUser.mutateAsync({ id: user.id, status });
    } catch (e) {
      setError(apiErrorMessage(e, "Could not update. Try again."));
    }
  };

  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, borderRadius: radius.lg, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Avatar name={user.name} size={40} glyph={initials(user.name)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: colors.text }}>{user.name}</span>
            <Pill bg={roleTone.bg} fg={roleTone.fg}>{user.role}</Pill>
          </div>
          <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 2 }}>
            {user.phone}
            {user.employee_number ? ` · Emp #${user.employee_number}` : ""}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button size="sm" variant="ghost" onClick={() => decide("disabled")} disabled={approveUser.isPending} style={{ color: colors.red, flex: 1 }}>
          Reject
        </Button>
        <Button size="sm" variant="success" onClick={() => decide("active")} disabled={approveUser.isPending} style={{ flex: 2 }}>
          Approve
        </Button>
      </div>
      {error && <div style={{ color: colors.red, fontSize: 12.5, fontWeight: 600, marginTop: 8 }}>{error}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  appbar: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    background: colors.blue,
    borderBottom: `3px solid ${colors.yellow}`,
    padding: "12px 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  logo: { width: 34, height: 34, background: colors.yellow, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center" },
  signOut: {
    background: "rgba(255,255,255,0.14)",
    color: "#fff",
    border: "none",
    borderRadius: radius.md,
    padding: "8px 14px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
  h2: { fontSize: 16, fontWeight: 800, color: colors.text, margin: "0 0 12px", display: "flex", alignItems: "center", gap: 8 },
  countDot: {
    background: colors.orange,
    color: "#fff",
    borderRadius: radius.pill,
    fontSize: 12,
    fontWeight: 800,
    padding: "1px 8px",
  },
};
