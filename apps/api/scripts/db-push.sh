#!/usr/bin/env sh
# Push the Prisma schema, tolerating a concurrent push of the same change.
#
# One railway.json drives two services — the API and the billing worker, which
# the start command tells apart by BILLING_WORKER. Both build from this repo on
# every push to main, so both run this at the same time against the one Supabase
# database. Prisma computes its diff before it applies it, so on a schema change
# the slower build asks to add a column the faster one has already added, and
# dies on `column "x" of relation "y" already exists` — the deploy fails over a
# migration that in fact succeeded.
#
# So: push, and if the push fails, pass only when the database already matches
# the datamodel. A real fault — a bad schema, an unreachable database, a change
# that did not land — leaves a difference, and the diff fails the build as
# before. The only thing forgiven is losing the race.
set -e

SCHEMA=../web/prisma/schema.prisma

if prisma db push --schema="$SCHEMA"; then
  exit 0
fi

echo "[db:push] push failed — checking whether a concurrent deploy already applied it"
prisma migrate diff \
  --from-schema-datasource "$SCHEMA" \
  --to-schema-datamodel "$SCHEMA" \
  --exit-code
echo "[db:push] database already matches the schema; the other deploy applied it. Continuing."
