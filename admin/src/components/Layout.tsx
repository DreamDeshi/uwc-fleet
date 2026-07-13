import { Suspense, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { colors, gradients, radius } from "@/theme";
import { useAuth } from "@/context/AuthContext";
import { usePendingUsers, useDashboard, useTruckAlerts } from "@/hooks/queries";
import { formatFullDate, initials } from "@/lib/format";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { useIsMobile } from "@/hooks/useIsMobile";

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

// Sidebar sections — purely presentational grouping of the same routes, in
// working order: the dispatcher's day first, configuration second.
const byRoute = new Map(navItems.map((i) => [i.to, i]));
const group = (routes: string[]) => routes.map((r) => byRoute.get(r)!);
const navGroups: { heading: string; items: NavItem[] }[] = [
  { heading: "Overview", items: group(["/"]) },
  { heading: "Operations", items: group(["/trips", "/drivers", "/trucks", "/performance"]) },
  { heading: "Administration", items: group(["/incentives", "/approvals", "/consignees", "/reports"]) },
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
  // Below 768px the sidebar becomes an off-canvas drawer behind a hamburger;
  // desktop keeps the fixed 248px column untouched.
  const mobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);

  const page = pageTitles[location.pathname] ?? { title: "Dashboard", subtitle: "" };
  const pendingCount = pending.data?.length ?? 0;
  const alertCount = dashboard.data?.alerts ?? 0;
  const truckAlertCount = truckAlerts.data?.length ?? 0;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {/* Scrim behind the open drawer — tap anywhere outside to close. */}
      {mobile && navOpen && (
        <div
          onClick={() => setNavOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(16,24,40,0.5)", zIndex: 940 }}
        />
      )}

      {/* ── Sidebar ── */}
      <aside
        style={{
          width: 248,
          background: gradients.sidebar,
          borderRight: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          overflowY: "auto",
          // Drawer mode: slides in over the content (kept below the 1000-level
          // modals so a dialog always wins).
          ...(mobile
            ? {
                position: "fixed" as const,
                top: 0,
                bottom: 0,
                left: 0,
                zIndex: 950,
                transform: navOpen ? "translateX(0)" : "translateX(-100%)",
                transition: "transform 0.22s ease",
                boxShadow: navOpen ? "0 0 40px rgba(0,0,0,0.35)" : undefined,
              }
            : null),
        }}
      >
        <div style={{ padding: "26px 20px 20px", display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 42,
              height: 42,
              background: colors.yellow,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 8px 18px -6px rgba(255,204,0,0.45)",
              flexShrink: 0,
            }}
          >
            <svg width="24" height="16" viewBox="0 0 22 15" fill="none">
              <rect x="0" y="4" width="14" height="9" rx="2" fill={colors.blue} />
              <rect x="14" y="6" width="8" height="7" rx="2" fill={colors.blue} />
              <circle cx="4" cy="13" r="2" fill={colors.blue} />
              <circle cx="18" cy="13" r="2" fill={colors.blue} />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", letterSpacing: 0.4 }}>UWC TRUCKING</div>
            <div style={{ fontSize: 10.5, color: colors.yellow, fontWeight: 700, letterSpacing: 1.8 }}>FLEET MANAGEMENT</div>
          </div>
        </div>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "0 16px 6px" }} />

        <nav style={{ flex: 1, padding: "4px 12px 0" }}>
          {navGroups.map((g) => (
            <div key={g.heading}>
              <div
                style={{
                  fontSize: 11.5,
                  fontWeight: 800,
                  letterSpacing: 1.8,
                  color: "rgba(255,255,255,0.32)",
                  padding: "14px 10px 7px",
                  textTransform: "uppercase",
                }}
              >
                {g.heading}
              </div>
              {g.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  style={{ display: "block" }}
                  onClick={mobile ? () => setNavOpen(false) : undefined}
                >
                  {({ isActive }) => (
                    <div
                      className={isActive ? undefined : "uwc-nav-link"}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        width: "100%",
                        padding: "10px 12px",
                        borderRadius: 10,
                        // The active page is unmistakable: a solid corporate-yellow
                        // pill with navy ink, floating on its own soft glow.
                        background: isActive ? colors.yellow : "transparent",
                        color: isActive ? colors.navy : "rgba(255,255,255,0.62)",
                        fontWeight: isActive ? 800 : 500,
                        fontSize: 14,
                        marginBottom: 3,
                        boxShadow: isActive ? "0 8px 18px -8px rgba(255,204,0,0.55)" : undefined,
                      }}
                    >
                      <span style={{ color: isActive ? colors.navy : "rgba(255,255,255,0.38)", display: "flex" }}>{item.icon}</span>
                      <span>{item.label}</span>
                      {item.to === "/approvals" && pendingCount > 0 && (
                        <span
                          style={{
                            marginLeft: "auto",
                            background: isActive ? colors.navy : colors.yellow,
                            color: isActive ? colors.yellow : colors.navy,
                            borderRadius: radius.pill,
                            fontSize: 12,
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
                            fontSize: 12,
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
            </div>
          ))}
        </nav>

        <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "8px 16px" }} />
        <div style={{ padding: "8px 12px" }}>
          <button
            className="uwc-nav-link"
            onClick={logout}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.14)",
              background: "transparent",
              cursor: "pointer",
              color: "rgba(255,255,255,0.6)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Sign Out
          </button>
        </div>

        <div style={{ margin: "8px 12px 16px", padding: 12, background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.09)", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
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
              fontSize: 14,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {user ? initials(user.name) : "?"}
          </div>
          <div style={{ overflow: "hidden" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>
              {user?.name ?? "Admin"}
            </div>
            <div style={{ fontSize: 12, color: "rgba(255,255,255,0.45)" }}>Fleet Administrator</div>
          </div>
        </div>
      </aside>

      {/* ── Main column ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: colors.bg }}>
        <header
          style={{
            background: gradients.header,
            borderBottom: `4px solid ${colors.yellow}`,
            padding: mobile ? "0 14px" : "0 28px",
            height: 66,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
            boxShadow: "0 6px 18px -8px rgba(0,32,90,0.5)",
            position: "relative",
            zIndex: 5,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
            {mobile && (
              <button
                onClick={() => setNavOpen(true)}
                aria-label="Open menu"
                style={{
                  border: "none",
                  background: "rgba(255,255,255,0.12)",
                  borderRadius: 10,
                  width: 40,
                  height: 40,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                  <path d="M4 6h16M4 12h16M4 18h16" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: mobile ? 17 : 21,
                  fontWeight: 800,
                  color: "#fff",
                  letterSpacing: -0.2,
                  ...(mobile
                    ? { whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }
                    : null),
                }}
              >
                {page.title}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: "rgba(255,255,255,0.65)",
                  marginTop: -1,
                  ...(mobile
                    ? { whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }
                    : null),
                }}
              >
                {page.subtitle}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
            {!mobile && (
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.85)",
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.14)",
                  borderRadius: radius.pill,
                  padding: "6px 13px",
                }}
              >
                {formatFullDate(new Date())}
              </div>
            )}
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
                    fontSize: 11,
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

        <main style={{ flex: 1, overflowY: "auto", padding: mobile ? "14px 14px 28px" : "24px 28px" }}>
          <Suspense fallback={<FullScreenLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
