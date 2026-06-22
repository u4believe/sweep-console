import { Link } from "react-router-dom";

const active = "rounded-md bg-white py-2 text-center text-sm font-semibold text-gray-900 shadow-sm";
const idle = "rounded-md py-2 text-center text-sm font-medium text-gray-500 transition hover:text-gray-800";

export function AuthTabs({ current }: { current: "login" | "signup" }) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1">
      <Link to="/login" className={current === "login" ? active : idle}>Login</Link>
      <Link to="/signup" className={current === "signup" ? active : idle}>Sign Up</Link>
    </div>
  );
}

export function OrDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-gray-200" />
      <span className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</span>
      <span className="h-px flex-1 bg-gray-200" />
    </div>
  );
}
