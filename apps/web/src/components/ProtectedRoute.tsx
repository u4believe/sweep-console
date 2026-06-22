import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth";

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-gray-400">Loading…</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }

  // New accounts that still owe a company name (e.g. fresh Google sign-ups) must
  // finish onboarding before reaching the portal.
  if (!user.onboarded && location.pathname !== "/welcome") {
    return <Navigate to="/welcome" replace />;
  }

  return <Outlet />;
}
