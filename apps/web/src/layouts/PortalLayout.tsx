import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "@/context/auth";
import { Logo } from "@/components/ui/Logo";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/plans", label: "Plans" },
  { href: "/subscriptions", label: "Subscriptions" },
  { href: "/payments", label: "Payments" },
  { href: "/webhooks", label: "Webhooks" },
  { href: "/api-keys", label: "API Keys" },
  { href: "/settings", label: "Settings" },
];

export function PortalLayout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="flex h-16 items-center border-b border-gray-100 px-6 gap-2">
          <Logo height={28} />
          <span className="text-base font-bold text-gray-900 tracking-tight">Sweep Console</span>
        </div>
        <nav className="p-4 flex-1">
          <ul className="space-y-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  to={item.href}
                  className={`flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors
                    ${pathname === item.href
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
                    }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="border-t border-gray-100 p-4">
          <p className="text-xs text-gray-500 truncate mb-2">{user?.email}</p>
          <button
            onClick={() => void logout()}
            className="text-xs text-gray-500 hover:text-gray-800 transition"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-gray-50">
        <div className="mx-auto max-w-6xl px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
