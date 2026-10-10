# What the payer is told

Sweep emails a receipt whenever a charge settles, to the email on the mandate —
the one they proved, if it differs from the one you sent.

It states what was taken, by whom, which chain it came from, the Arc
transaction, and the ceiling it was collected under. A standing debit the payer
never sees coming reads as an unexplained withdrawal otherwise.

## Two things it deliberately does not say

Because Sweep cannot know them:

- **A next-charge date.** Your app owns the schedule.
- **A plan name.** The only description the payer sees is the `description` you
  send with the charge — so write it for them, not for your logs.

`email` is optional on a mandate. Omit it and no receipt can be sent, unless the
payer supplies their own at the authorization step.

## What is still yours to send

Product mail beyond the receipt — dunning, renewal reminders, anything tied to
your plans. `charge.succeeded` carries `amount`, `source_chain`, the Arc
`tx_hash` and your `external_ref`.

## Trials are yours too

A mandate has no trial: it is an authorization, not a plan. A free period on the
rail is simply **you not calling `POST /v1/charges` until it ends**. Authorize on
day one, charge on day fifteen — the mandate sits `active` and costs the payer
nothing in between.

## So are renewals

There is no renewal endpoint and no `charge.renewed`, because the rail has no
concept of a first charge versus a later one. Every collection is a charge, and
your app already knows which is which.

Charging monthly means calling `POST /v1/charges` once a month.
