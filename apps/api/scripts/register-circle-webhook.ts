import "dotenv/config";

const BASE = process.env.CIRCLE_BASE_URL ?? "https://api.circle.com";
const API_KEY = process.env.CIRCLE_API_KEY;
const WEBHOOK_URL = process.env.CIRCLE_WEBHOOK_URL;

if (!API_KEY) { console.error("❌  CIRCLE_API_KEY is not set in .env"); process.exit(1); }
if (!WEBHOOK_URL) { console.error("❌  CIRCLE_WEBHOOK_URL is not set in .env"); process.exit(1); }

async function main() {
  console.log(`Registering webhook with Circle…`);
  console.log(`  URL: ${WEBHOOK_URL}`);

  const res = await fetch(`${BASE}/v2/notifications/subscriptions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      endpoint: WEBHOOK_URL,
      notificationTypes: ["transactions.inbound", "transactions.outbound"],
    }),
  });

  const json = await res.json();
  console.log("\nCircle response:", JSON.stringify(json, null, 2));

  if (!res.ok) {
    console.error(`\n❌  Registration failed (HTTP ${res.status})`);
    process.exit(1);
  }

  const sub = (json as { data?: { id?: string; endpoint?: string } }).data;
  console.log(`\n✅  Subscription registered`);
  console.log(`   ID:       ${sub?.id ?? "?"}`);
  console.log(`   Endpoint: ${sub?.endpoint ?? "?"}`);
  console.log(`\nCircle will now POST transactions.inbound events to ${WEBHOOK_URL}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
