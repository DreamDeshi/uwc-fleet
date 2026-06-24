import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { colors } from "@/theme";
import { Layout } from "@/components/Layout";
import { LoginPage } from "@/pages/LoginPage";
import { DashboardPage } from "@/pages/DashboardPage";
import { TripsPage } from "@/pages/TripsPage";
import { DriversPage } from "@/pages/DriversPage";
import { TrucksPage } from "@/pages/TrucksPage";
import { IncentivesPage } from "@/pages/IncentivesPage";
import { ApprovalsPage } from "@/pages/ApprovalsPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { MobileLitePage } from "@/pages/MobileLitePage";
import { useIsMobile } from "@/hooks/useIsMobile";

function FullScreenLoader() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: colors.bg,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          border: `3px solid ${colors.border}`,
          borderTopColor: colors.blue,
          borderRadius: "50%",
          animation: "uwc-spin 0.8s linear infinite",
        }}
      />
    </div>
  );
}

export default function App() {
  const { status } = useAuth();
  const isMobile = useIsMobile();

  if (status === "loading") return <FullScreenLoader />;

  if (status === "guest") {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  // On a phone, the desktop dashboard is unusable — route admins to the touch
  // "lite" screen (dispatch + approvals). Desktop keeps the full app, with /m
  // reachable for previewing the mobile view.
  if (isMobile) {
    return (
      <Routes>
        <Route path="/m" element={<MobileLitePage />} />
        <Route path="*" element={<Navigate to="/m" replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/drivers" element={<DriversPage />} />
        <Route path="/trucks" element={<TrucksPage />} />
        <Route path="/incentives" element={<IncentivesPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
      </Route>
      <Route path="/m" element={<MobileLitePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
