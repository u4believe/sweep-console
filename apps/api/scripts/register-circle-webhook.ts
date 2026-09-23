// Point Circle's notifications at this deployment.
//
//   pnpm --filter @sweep/api circle:register-webhook                      # use CIRCLE_WEBHOOK_URL
//   pnpm --filter @sweep/api circle:register-webhook <url>                # use this URL instead
//   pnpm --filter @sweep/api circle:register-webhook <url> --replace      # and remove the others
//
// Two things this exists to prevent, both learned the hard way.
//
// The URL is an argument, not only an environment variable, because the variable
// this reads is the one in YOUR shell — `dotenv/config` loads apps/api/.env. A
// URL changed on the host is not the URL this script sends, so running it after
// updating Railway would cheerfully register whatever tunnel you last used
// locally.
//
// And Circle's POST creates a subscription rather than updating one. Run it
// twice and Circle delivers to both endpoints, which is how a retired tunnel
// keeps receiving production events. So: list first, do nothing if it is
// already right, and only remove the others when asked to.

import "dotenv/config";

const BASE = process.env.CIRCLE_BASE_URL ?? "https://api.circle.com";
const API_KEY = process.env.CIRCLE_API_KEY;

const args = process.argv.slice(2);
const replace = args.includes("--replace");
const urlArg = args.find((a) => !a.startsWith("--"));
const WEBHOOK_URL = urlArg ?? process.env.CIRCLE_WEBHOOK_URL;

if (!API_KEY) {
  console.error("CIRCLE_API_KEY is not set.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("No URL. Pass one as an argument, or set CIRCLE_WEBHOOK_URL.");
  process.exit(1);
}

interface Subscription {
  id?: string;
  endpoint?: string;
  enabled?: boolean;
}

async function circle<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

async function main() {
  console.log(`Target endpoint: ${WEBHOOK_URL}\n`);

  const existing = await circle<{ data?: { subscriptions?: Subscription[] } | Subscription[] }>(
    "GET",
    "/v2/notifications/subscriptions"
  );
  const raw = existing.json?.data;
  const subs: Subscription[] = Array.isArray(raw) ? raw : (raw?.subscriptions ?? []);

  if (subs.length === 0) {
    console.log("No subscriptions registered yet.");
  } else {
    console.log(`${subs.length} subscription(s) currently registered:`);
    for (const s of subs) {
      const mark = s.endpoint === WEBHOOK_URL ? "→" : " ";
      console.log(`  ${mark} ${s.id ?? "?"}  ${s.endpoint ?? "?"}`);
    }
    console.log();
  }

  const already = subs.find((s) => s.endpoint === WEBHOOK_URL);
  if (already) {
    console.log(`Already registered as ${already.id}. Nothing to create.`);
  } else {
    const created = await circle<{ data?: Subscription }>("POST", "/v2/notifications/subscriptions", {
      endpoint: WEBHOOK_URL,
      notificationTypes: ["transactions.inbound", "transactions.outbound"],
    });
    if (created.status >= 300) {
      console.error(`Registration failed (HTTP ${created.status}):`, JSON.stringify(created.json, null, 2));
      process.exit(1);
    }
    console.log(`Registered: ${created.json?.data?.id ?? "?"} → ${WEBHOOK_URL}`);
  }

  const stale = subs.filter((s) => s.endpoint !== WEBHOOK_URL && s.id);
  if (stale.length === 0) return;

  if (!replace) {
    console.log(
      `\n${stale.length} other subscription(s) still registered. Circle delivers to every one of them, ` +
        `so a retired tunnel keeps receiving production events.\nRe-run with --replace to remove them.`
    );
    return;
  }

  for (const s of stale) {
    const del = await circle("DELETE", `/v2/notifications/subscriptions/${s.id}`);
    console.log(del.status < 300 ? `Removed ${s.id} (${s.endpoint})` : `Could not remove ${s.id}: HTTP ${del.status}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
