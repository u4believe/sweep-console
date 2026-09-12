// Strips retired event types from stored WebhookEndpoint.events arrays.
//
// WEBHOOK_EVENTS is both the offered list and the zod enum a create/update is
// validated against. Removing an event from it leaves any endpoint that already
// subscribed to it holding a value the API will now reject — so the next time
// the merchant edits that endpoint in the portal, the form posts back what it
// loaded and eats a 422 that only says "Validation failed". Prune the stored
// rows in the same change that retires the event.
//
// Dry run by default; pass --write.
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { WEBHOOK_EVENTS } from "../src/lib/webhooks/events";

(async () => {
  const write = process.argv.includes("--write");
  const live = new Set<string>(WEBHOOK_EVENTS);

  const endpoints = await prisma.webhookEndpoint.findMany({
    select: { id: true, endpointId: true, url: true, events: true, isActive: true },
  });

  let changed = 0;
  for (const ep of endpoints) {
    const keep = ep.events.filter((e) => live.has(e));
    const drop = ep.events.filter((e) => !live.has(e));
    if (!drop.length) continue;
    changed++;
    console.log(`${ep.endpointId} ${ep.url} (active=${ep.isActive})`);
    console.log(`  dropping: ${drop.join(", ")}`);
    console.log(`  keeping:  ${keep.join(", ") || "(none)"}`);

    // An endpoint left with no events would be unsaveable (the enum requires at
    // least one) and would silently receive nothing. Flag it rather than guess.
    if (!keep.length) {
      console.log("  !! this endpoint subscribed ONLY to retired events — leaving it for a human");
      continue;
    }
    if (write) {
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { events: keep } });
      console.log("  updated");
    }
  }

  console.log(`\n${changed} of ${endpoints.length} endpoint(s) affected`);
  if (changed && !write) console.log("dry run; pass --write");
})().finally(() => prisma.$disconnect());
