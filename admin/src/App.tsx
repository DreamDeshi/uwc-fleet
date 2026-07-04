import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Layout } from "@/components/Layout";
import { FullScreenLoader } from "@/components/FullScreenLoader";
import { useIsMobile } from "@/hooks/useIsMobile";

// Route-level code splitting: each page (and its heavy deps — Leaflet on the
// dashboard, Recharts on reports) ships as its own chunk loaded on navigation,
// instead of one ~890 KB bundle on first paint. Pages use named exports, so we
// map them onto `default` for React.lazy.
const lazyPage = <T extends Record<string, React.ComponentType<unknown>>>(
  loader: () => Promise<T>,
  name: keyof T
) => lazy(() => loader().then((m) => ({ default: m[name] })));

const LoginPage = lazyPage(() => import("@/pages/LoginPage"), "LoginPage");
const DashboardPage = lazyPage(() => import("@/pages/DashboardPage"), "DashboardPage");
const TripsPage = lazyPage(() => import("@/pages/TripsPage"), "TripsPage");
const DriversPage = lazyPage(() => import("@/pages/DriversPage"), "DriversPage");
const PerformancePage = lazyPage(() => import("@/pages/PerformancePage"), "PerformancePage");
const TrucksPage = lazyPage(() => import("@/pages/TrucksPage"), "TrucksPage");
const IncentivesPage = lazyPage(() => import("@/pages/IncentivesPage"), "IncentivesPage");
const ApprovalsPage = lazyPage(() => import("@/pages/ApprovalsPage"), "ApprovalsPage");
const ConsigneesPage = lazyPage(() => import("@/pages/ConsigneesPage"), "ConsigneesPage");
const ReportsPage = lazyPage(() => import("@/pages/ReportsPage"), "ReportsPage");
const MobileLitePage = lazyPage(() => import("@/pages/MobileLitePage"), "MobileLitePage");

export default function App() {
  const { status } = useAuth();
  const isMobile = useIsMobile();

  if (status === "loading") return <FullScreenLoader />;

  if (status === "guest") {
    return (
      <Suspense fallback={<FullScreenLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // On a phone, the desktop dashboard is unusable — route admins to the touch
  // "lite" screen (dispatch + approvals). Desktop keeps the full app, with /m
  // reachable for previewing the mobile view.
  if (isMobile) {
    return (
      <Suspense fallback={<FullScreenLoader />}>
        <Routes>
          <Route path="/m" element={<MobileLitePage />} />
          <Route path="*" element={<Navigate to="/m" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // Authenticated desktop app. Each page chunk loads on navigation; the Suspense
  // boundary lives inside Layout (around the Outlet) so the sidebar stays put
  // while a page streams in. The /m preview route gets its own boundary.
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/drivers" element={<DriversPage />} />
        <Route path="/performance" element={<PerformancePage />} />
        <Route path="/trucks" element={<TrucksPage />} />
        <Route path="/incentives" element={<IncentivesPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/consignees" element={<ConsigneesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
      </Route>
      <Route
        path="/m"
        element={
          <Suspense fallback={<FullScreenLoader />}>
            <MobileLitePage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
