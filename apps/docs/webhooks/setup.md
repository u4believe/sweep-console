# Set up an endpoint

Rather than polling, Sweep **pushes events to your server** the moment they
happen — a subscription is created, a payment succeeds, a renewal fails. Your
app reacts in real time: grant access, update your database, send your own mail.

## Two ways to create one

### From the dashboard

Dashboard → Webhooks → Add endpoint. Paste your HTTPS URL, tick the events you
care about, and save.

You are shown a **signing secret**. Copy it then — it is how you verify that an
incoming event really came from Sweep.

### From the API

```sh
curl -X POST https://api.sweepconsole.xyz/v1/webhooks \
  -H "Authorization: Bearer $SWEEP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://yourapp.com/webhooks/sweep",
    "events": ["subscription.created", "payment.succeeded", "subscription.cancelled"]
  }'
```

The response includes the secret. Store it the way you store any credential.

## Requirements on the URL

It must be **HTTPS and publicly reachable**. Private addresses are refused —
`localhost`, `10.x`, and the cloud metadata address among them — and the
hostname is re-resolved and re-checked **before every delivery**, so a name that
was public at registration cannot later point somewhere internal.

For local testing, expose your dev server with a tunnel and register that URL.

::: tip The URL is only half of it
Saving it tells us where to send events. Something has to be listening — see
[What your app must have](/webhooks/your-code).
:::
