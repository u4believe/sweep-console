# Upgrades & price changes

## Upgrading

An account has one plan with tiers, so an upgrade means **moving to a higher
tier**. Mechanically that is a cancel and resubscribe.

The chosen tier's amount and interval are **snapshotted onto the new
subscription**, so it keeps billing those terms even if the tier is repriced
later — unless you explicitly reprice existing subscribers.

Completing the new subscription replaces the old one, and the checkout also
offers to revoke the old one first. When a subscriber upgrades with the **same
wallet** that already enabled cross-chain renewals, the grant carries over — no
second signature while it is still active.

## Changing a price

A tier's price is editable. Its interval is not: the interval is part of what
every subscriber's wallet signed, so changing it would mean re-collecting
consent from all of them. A new tier is the honest way to do that.

You will be asked to confirm it is you before a price change is saved.

### Who it applies to

You choose the scope when you change one — new subscribers only, or existing
ones too.

::: info Every affected subscriber is emailed
Whichever scope you pick, and it is not optional. A recurring charge that
quietly changes size is the thing a standing payment authorization is most often
abused for.
:::

### Raising a price

Allowed, with one consequence worth understanding.

A subscriber's renewal permission has a **signed ceiling**. If the new price is
above it, Sweep does not charge them and does not count it as a failed payment.
They are asked to re-authorize at the new amount instead, and keep their
subscription in the meantime.

Lowering a price needs nothing from anyone.
