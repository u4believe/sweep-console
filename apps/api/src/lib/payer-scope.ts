/**
 * The mode filter for payer-facing reads.
 *
 * There are three doors into this database and each learns the mode a
 * different way:
 *
 *   the API        from the KEY          merchantScope(req)
 *   the dashboard  from the DEPLOYMENT   portalScope(req)
 *   the payer      from the DEPLOYMENT   payerScope()        <- here
 *
 * A payer has neither a key nor a merchant session — they prove an email and
 * see what belongs to it. So nothing in the request says which network they
 * are on, and the deployment is the only thing that can.
 *
 * Without it the live customer portal listed every subscription and mandate
 * for that email across BOTH networks, because the database is shared: a payer
 * on www.sweepconsole.xyz saw their Sepolia test subscriptions beside real
 * ones, with revoke and cancel buttons against each.
 *
 * check-mode-scoping.ts missed this for a year because it looks for a merchant
 * id in the where clause, and a payer read has no merchant in it at all.
 */

import { isMainnet } from "./gateway/chains";

/** Spread into any `where` that reads a mode-bearing row for a payer. */
export function payerScope(): { isTestMode: boolean } {
  return { isTestMode: !isMainnet() };
}
