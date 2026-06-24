import { Routes, Route, Navigate } from "react-router-dom";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PublicRoute } from "@/components/PublicRoute";
import { AuthLayout } from "@/layouts/AuthLayout";
import { PortalLayout } from "@/layouts/PortalLayout";
import { LoginPage } from "@/pages/auth/LoginPage";
import { SignupPage } from "@/pages/auth/SignupPage";
import { VerifyEmailPage } from "@/pages/auth/VerifyEmailPage";
import { ForgotPasswordPage } from "@/pages/auth/ForgotPasswordPage";
import { ResetPasswordPage } from "@/pages/auth/ResetPasswordPage";
import { DashboardPage } from "@/pages/portal/DashboardPage";
import { PlansPage } from "@/pages/portal/PlansPage";
import { PlansNewPage } from "@/pages/portal/PlansNewPage";
import { SubscriptionsPage } from "@/pages/portal/SubscriptionsPage";
import { PaymentsPage } from "@/pages/portal/PaymentsPage";
import { WebhooksPage } from "@/pages/portal/WebhooksPage";
import { ApiKeysPage } from "@/pages/portal/ApiKeysPage";
import { SettingsPage } from "@/pages/portal/SettingsPage";
import { CheckoutPage } from "@/pages/CheckoutPage";
import { PaymentLinkPage } from "@/pages/PaymentLinkPage";
import { DevGrantTestPage } from "@/pages/DevGrantTestPage";
import { LandingPage } from "@/pages/LandingPage";
import { DocsPage } from "@/pages/DocsPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { AnalyticsPage } from "@/pages/AnalyticsPage";
import { ManageSubscriptionsPage } from "@/pages/ManageSubscriptionsPage";

export default function App() {
  return (
    <Routes>
      {/* Public marketing landing page + documentation */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/docs" element={<DocsPage />} />
      <Route path="/analytics" element={<AnalyticsPage />} />

      {/* Auth pages — redirect to dashboard if already logged in */}
      <Route element={<PublicRoute />}>
        <Route element={<AuthLayout />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>
      </Route>

      {/* Checkout — fully public, no auth required */}
      <Route path="/checkout/:session_id" element={<CheckoutPage />} />

      {/* Payment links — public, shareable; mints a session on subscribe */}
      <Route path="/pay/:link_id" element={<PaymentLinkPage />} />

      {/* Standalone customer portal — public, email+OTP gated inside */}
      <Route path="/manage" element={<ManageSubscriptionsPage />} />

      {/* Dev-only: ERC-7715 grant + caveat-scope test harness */}
      {import.meta.env.DEV && (
        <Route path="/dev/grant-test" element={<DevGrantTestPage />} />
      )}

      {/* Portal — requires authentication */}
      <Route element={<ProtectedRoute />}>
        {/* Standalone onboarding (no portal chrome) — new Google accounts set their company name */}
        <Route path="/welcome" element={<OnboardingPage />} />
        <Route element={<PortalLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/plans/new" element={<PlansNewPage />} />
          <Route path="/subscriptions" element={<SubscriptionsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="/api-keys" element={<ApiKeysPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
