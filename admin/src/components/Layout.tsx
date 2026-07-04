import { Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { colors, radius } from "@/theme";
import { useAuth } from "@/context/AuthContext";
import { usePendingUsers, useDashboard, useTruckAlerts } from "@/hooks/queries";
import { formatFullDate, initials } from "@/lib/format";
import { FullScreenLoader } from "@/components/FullScreenLoader";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const navItems: NavItem[] = [
  {
    to: "/",
    label: "Dashboard",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <rect x="1" y="1" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="10" y="1" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="1" y="10" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <rect x="10" y="10" width="7" height="7" rx="2" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    to: "/trips",
    label: "Trip Management",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/drivers",
    label: "Driver Management",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    to: "/performance",
    label: "Performance",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M8 21h8M12 17v4M6 4h12v5a6 6 0 01-12 0V4z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18 5h2.5a2 2 0 010 4H18M6 5H3.5a2 2 0 000 4H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/trucks",
    label: "Truck Management",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <rect x="1" y="6" width="15" height="10" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <path d="M16 9h4l3 3v4h-7V9z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <circle cx="6" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="19" cy="17" r="2" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    ),
  },
  {
    to: "/incentives",
    label: "Incentive Rates",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M12 1v22M17 5H9.5a3.5 3.5 0 100 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/approvals",
    label: "User Approvals",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8" />
        <path d="M17 11l2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/consignees",
    label: "Consignees",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M3 21h18M5 21V7l7-4 7 4v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9 21v-6h6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: "/reports",
    label: "Reports",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const pageTitles: Record<string, { title: string; subtitle: string }> = {
  "/": { title: "Dashboard", subtitle: "Live fleet overview" },
  "/trips": { title: "Trip Management", subtitle: "Dispatch & monitor bookings" },
  "/drivers": { title: "Driver Management", subtitle: "Drivers & performance" },
  "/performance": { title: "Driver Performance", subtitle: "Reliability, productivity & workload" },
  "/trucks": { title: "Truck Management", subtitle: "Fleet & document expiries" },
  "/incentives": { title: "Incentive Rate Management", subtitle: "Claim rates & destination points" },
  "/approvals": { title: "User Approval Queue", subtitle: "New account registrations" },
  "/consignees": { title: "Consignee Directory", subtitle: "Fix zones, rename, deactivate" },
  "/reports": { title: "Reports & Analytics", subtitle: "Trips, incentives & utilisation" },
};

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const pending = usePendingUsers();
  const dashboard = useDashboard();
  const truckAlerts = useTruckAlerts();

  const page = pageTitles[location.pathname] ?? { title: "Dashboard", subtitle: "" };
  const pendingCount = pending.data?.length ?? 0;
  const alertCount = dashboard.data?.alerts ?? 0;
  const truckAlertCount = truckAlerts.data?.length ?? 0;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* ── Sidebar ── */}
      <aside
        style={{
          width: 240,
          background: colors.navy,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          overflowY: "auto",
        }}
      >
        <div style={{ padding: "24px 20px 18px", display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 38,
              height: 38,
              background: colors.yellow,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <svg width="22" height="15" viewBox="0 0 22 15" fill="none">
              <rect x="0" y="4" width="14" height="9" rx="2" fill={colors.blue} />
              <rect x="14" y="6" width="8" height="7" rx="2" fill={colors.blue} />
              <circle cx="4" cy="13" r="2" fill={colors.blue} />
              <circle cx="18" cy="13" r="2" fill={colors.blue} />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", letterSpacing: 0.5 }}>UWC TRUCKING</div>
            <div style={{ fontSize: 10, color: colors.yellow, fontWeight: 600, letterSpacing: 1 }}>FLEET MANAGEMENT</div>
          </div>
        </div>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 16px 8px" }} />
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 1.5,
            color: "rgba(255,255,255,0.35)",
            padding: "12px 20px 8px",
            textTransform: "uppercase",
          }}
        >
          Main Menu
        </div>

        <nav style={{ flex: 1, padding: "0 12px" }}>
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"} style={{ display: "block" }}>
              {({ isActive }) => (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    width: "100%",
                    padding: "11px 12px",
                    borderRadius: 10,
                    borderLeft: `3px solid ${isActive ? colors.yellow : "transparent"}`,
                    background: isActive ? "rgba(255,204,0,0.1)" : "transparent",
                    color: isActive ? colors.yellow : "rgba(255,255,255,0.65)",
                    fontWeight: isActive ? 700 : 500,
                    fontSize: 14,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: isActive ? colors.yellow : "rgba(255,255,255,0.4)", display: "flex" }}>{item.icon}</span>
                  <span>{item.label}</span>
                  {item.to === "/approvals" && pendingCount > 0 && (
                    <span
                      style={{
                        marginLeft: "auto",
                        background: colors.yellow,
                        color: colors.navy,
                        borderRadius: radius.pill,
                        fontSize: 11,
                        fontWeight: 800,
                        padding: "1px 7px",
                      }}
                    >
                      {pendingCount}
                    </span>
                  )}
                  {item.to === "/trucks" && truckAlertCount > 0 && (
                    <span
                      title={`${truckAlertCount} truck${truckAlertCount === 1 ? "" : "s"} with expiring or expired documents`}
                      style={{
                        marginLeft: "auto",
                        background: colors.red,
                        color: "#fff",
                        borderRadius: radius.pill,
                        fontSize: 11,
                        fontWeight: 800,
                        padding: "1px 7px",
                      }}
                    >
                      {truckAlertCount}
                    </span>
                  )}
                </div>
              )}
            </NavLink>
          ))}
        </nav>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "8px 16px" }} />
        <div style={{ padding: "8px 12px" }}>
          <button
            onClick={logout}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "rgba(255,255,255,0.55)",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign Out
          </button>
        </div>

        <div style={{ margin: "8px 12px 16px", padding: 12, background: "rgba(255,255,255,0.06)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: colors.blue,
              border: `2px solid ${colors.yellow}`,
              color: colors.yellow,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {user ? initials(user.name) : "?"}
          </div>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
              {user?.name ?? "Admin"}
            </div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>Fleet Administrator</div>
          </div>
        </div>
      </aside>

      {/* ── Main column ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: colors.bg }}>
        <header
          style={{
            background: colors.blue,
            borderBottom: `4px solid ${colors.yellow}`,
            padding: "0 28px",
            height: 64,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>{page.title}</div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", marginTop: -2 }}>{page.subtitle}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ fontSize: 12.5, color: "rgba(255,255,255,0.7)" }}>{formatFullDate(new Date())}</div>
            <div style={{ position: "relative" }}>
              <div
                style={{
                  background: "rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  width: 40,
                  height: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 22 22" fill="none">
                  <path d="M11 2a7 7 0 00-7 7c0 3 .7 5 2 6.5L5 19h12l-1-3.5C17.3 14 18 12 18 9a7 7 0 00-7-7z" stroke="#fff" strokeWidth="1.6" />
                  <path d="M9 19a2 2 0 004 0" stroke="#fff" strokeWidth="1.6" />
                </svg>
              </div>
              {alertCount > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 4,
                    right: 4,
                    minWidth: 16,
                    height: 16,
                    padding: "0 4px",
                    background: colors.red,
                    borderRadius: 8,
                    border: `1.5px solid ${colors.blue}`,
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 800,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {alertCount}
                </div>
              )}
            </div>
          </div>
        </header>

        <main style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          <Suspense fallback={<FullScreenLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
