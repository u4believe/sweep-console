import { Link } from "react-router-dom";
import { Logo } from "@/components/ui/Logo";
import { UMAMI_SHARE_URL } from "@/lib/analytics";

// Public, read-only analytics — embeds the Umami "share" dashboard on our own
// domain so anyone can see traffic stats. Falls back gracefully until configured.
export function AnalyticsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="sticky top-0 z-50 flex items-center justify-between border-b border-gray-100 bg-white/80 px-6 py-4 backdrop-blur-md">
        <Link to="/" className="flex items-center gap-2.5">
          <Logo height={28} />
          <span className="text-lg font-bold tracking-tight text-gray-900">Sweep Console</span>
          <span className="ml-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">Analytics</span>
        </Link>
        <div className="flex items-center gap-3 text-sm font-medium">
          <Link to="/" className="text-gray-600 transition hover:text-gray-900">Home</Link>
          {UMAMI_SHARE_URL && (
            <a
              href={UMAMI_SHARE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-xl bg-gray-900 px-4 py-2 text-white transition hover:bg-black"
            >
              Open full dashboard ↗
            </a>
          )}
        </div>
      </header>

      {UMAMI_SHARE_URL ? (
        <iframe
          title="Sweep Console — public analytics"
          src={UMAMI_SHARE_URL}
          className="w-full flex-1 border-0"
          style={{ minHeight: "calc(100vh - 65px)" }}
          loading="lazy"
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">
            <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none">
              <path d="M4 19V10m6 9V5m6 14v-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="mt-5 text-2xl font-bold text-gray-900">Public analytics</h1>
          <p className="mt-2 max-w-md text-sm text-gray-500">
            Live, cookieless traffic analytics for Sweep Console (powered by Umami) will appear here once the
            public dashboard is connected.
          </p>
          <Link to="/" className="mt-6 rounded-xl bg-gray-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-black">
            Back to home
          </Link>
        </div>
      )}
    </div>
  );
}
