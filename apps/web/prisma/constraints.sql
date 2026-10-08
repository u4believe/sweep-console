-- Constraints Prisma's schema language cannot express, applied after every
-- `db push` by apps/api/scripts/db-push.sh. Every statement must be idempotent:
-- this runs on every deploy.

-- One ACTIVE grant per (subscription, chain).
--
-- Two code paths keep this true by looking for an existing active row before
-- writing — routes/delegation.ts for a checkout grant, routes/customer-portal.ts
-- for a portal re-grant — and nothing but their agreement held the line. The
-- consequence of them disagreeing is not a tidy-data problem: a subscriber who
-- turns a chain off and grants it again leaves TWO live delegations in their
-- wallet, and ERC20PeriodTransferEnforcer counts its one-transfer-per-period
-- PER DELEGATION. Both would redeem. The renewal pass picks one grant per
-- subscription, so this never happened; it was prevented by a WHERE clause
-- rather than refused by the database.
--
-- Partial so the revoked history stays — turning a chain off and on again is
-- supposed to leave the old row behind — and so rail mandates, which carry no
-- subscription and dedupe by mandateId, are out of scope.
CREATE UNIQUE INDEX IF NOT EXISTS renewal_delegations_one_active_grant_per_chain
  ON public.renewal_delegations ("subscriptionId", "chainId")
  WHERE status = 'active' AND "subscriptionId" IS NOT NULL;
