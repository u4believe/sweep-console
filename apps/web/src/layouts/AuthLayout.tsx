import { Outlet } from "react-router-dom";
import { Logo } from "@/components/ui/Logo";

export function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-brand-50 via-white to-white">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="mb-8 flex flex-col items-center gap-3">
          <Logo height={48} />
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Sweep Console</h1>
        </div>

        <div className="w-full max-w-md">
          <Outlet />
        </div>

        <footer className="mt-10 text-center text-xs text-gray-400">
          A payment infrastructure for developers · Powered by stablecoins
        </footer>
      </main>
    </div>
  );
}
