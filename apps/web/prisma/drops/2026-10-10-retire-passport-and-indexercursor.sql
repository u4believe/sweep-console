-- Retire two models the code no longer references.
--
-- Audited 2026-10-10:
--   passports         13 rows, newest 2026-08-26. Superseded by Customer, which
--                     the API already says in a comment where /v1/passport used
--                     to be. 0 of 76 subscriptions carried a passportId, live or
--                     otherwise, so nothing points at these rows.
--   indexer_cursors    1 row, last written 2026-09-11, naming a testnet chain.
--                     Nothing in the repository references the model — the
--                     indexer that kept it was removed and left the table.
--
-- sweep_legs was also dead by the same test (90 rows, nothing written since
-- 2026-06-15, no references) and is deliberately KEPT: 37 sweeps still have
-- legs, and that per-leg detail cannot be reconstructed from the sweeps alone.
--
-- Both tables were exported to JSON before this ran. Written as explicit DDL
-- rather than `prisma db push --accept-data-loss`, which would also drop
-- anything else it judged to be drift — including the partial unique index on
-- renewal_delegations, which the schema cannot express.
--
-- Run:  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/web/prisma/drops/2026-10-10-retire-passport-and-indexercursor.sql

BEGIN;

ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS "passportId";
DROP TABLE IF EXISTS public.passports;
DROP TABLE IF EXISTS public.indexer_cursors;

COMMIT;
