import { PrismaClient } from "@prisma/client";

// How many times a query that never reached the database is re-sent, and the
// base backoff between tries (300ms, then 600ms).
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

/**
 * Was this a failure to CONNECT, rather than a failure of the query itself?
 *
 * The distinction is what makes retrying safe. Prisma raises these before the
 * statement leaves the client, so nothing ran on the server and re-sending
 * cannot duplicate a write. Anything that failed once the query was in flight —
 * a closed connection mid-statement (P1017), a pool timeout (P2024), a
 * constraint violation — is deliberately NOT retried: the write may already
 * have landed, and a second attempt would be a second write.
 */
export function isConnectFailure(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // Thrown when the client cannot establish a connection at all.
  if (e.name === "PrismaClientInitializationError") return true;
  const withCode = e as { code?: string; errorCode?: string };
  if (withCode.code === "P1001" || withCode.errorCode === "P1001") return true;
  // P1001's message, for the paths where the code arrives undefined — which it
  // does: the initialization error observed against Supabase carried
  // errorCode: undefined and only this text.
  return e.message.includes("Can't reach database server");
}

/**
 * The Prisma client, with connect failures retried for every query in the app.
 *
 * Supabase's shared endpoint drops the occasional connection — a blip of a
 * second or two, on both the pooled (6543) and direct (5432) ports. That is
 * normal for shared infrastructure and there is nothing to fix in the
 * connection itself; what matters is that one blip during a renewal run or a
 * checkout completion is absorbed instead of failing a merchant's request.
 *
 * This lives in a client extension rather than at each call site because there
 * are ~270 queries in this API and hand-wrapping them reached about 13% before
 * it was abandoned. An extension covers every one of them, including every
 * query written from here on, and cannot be forgotten.
 *
 * (The older `withRetry` helper could not be replaced by Prisma's `$use`
 * middleware, which is unable to re-invoke `next()`. Client extensions can
 * re-invoke `query()`, which is what makes this possible.)
 *
 * Operations inside a $transaction are NEVER retried — see inTransaction below.
 */
function createPrismaClient() {
  return new PrismaClient({ log: ["error"] }).$extends({
    query: {
      $allModels: {
        async $allOperations(params) {
          const { args, query } = params;

          // A batch or interactive transaction is atomic, and this callback
          // fires once per operation INSIDE it. Re-invoking query() there would
          // re-send that one statement on its own, outside the transaction that
          // was meant to contain it — so a blip mid-batch could apply one write
          // while its siblings never land. The billing engine batches a
          // subscription update with the payment row that pays for it; half of
          // that pair is worse than neither. Let the whole transaction fail and
          // be retried by its caller instead.
          if (inTransaction(params)) return query(args);

          for (let attempt = 1; ; attempt++) {
            try {
              return await query(args);
            } catch (e) {
              if (attempt >= MAX_ATTEMPTS || !isConnectFailure(e)) throw e;
              await new Promise((r) => setTimeout(r, BASE_DELAY_MS * attempt));
            }
          }
        },
      },
    },
  });
}

/**
 * Is this operation running inside a $transaction?
 *
 * Prisma exposes `__internalParams.transaction` — `{kind:"batch"}` for
 * `$transaction([...])`, `{kind:"itx"}` for the interactive form, and absent
 * outside one. It is an internal field, so this is written to fail SAFE: any
 * shape it doesn't recognise is treated as "inside a transaction", which costs
 * a retry rather than atomicity. Verified against Prisma 5.22; re-check on a
 * major upgrade.
 */
function inTransaction(params: unknown): boolean {
  const internal = (params as { __internalParams?: unknown }).__internalParams;
  if (internal === undefined || internal === null) return true; // unrecognised — assume unsafe
  if (typeof internal !== "object") return true;
  return "transaction" in internal
    ? (internal as { transaction?: unknown }).transaction != null
    : false;
}

export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

const globalForPrisma = globalThis as unknown as { prisma?: AppPrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * @deprecated Retries are handled for every query by the client above; this is
 * now a pass-through kept so the ~35 existing call sites keep reading the same.
 * Don't add new ones — just call Prisma directly.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}
