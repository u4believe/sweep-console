// Cross-chain checkout support routes.
//
//   GET /v1/wallet/balances?address=0x…       — per-chain USDC scanner (Arc + sources)
//   GET /checkout/:session_id/sweep/:sweep_id  — cross-chain activation status (polled
//        by the checkout UI; the Sweep is created by the cross-chain/activate route)
//
// The cross-chain ENABLE + ACTIVATE flow lives in routes/delegation.ts (it owns the
// delegation grants); this file just exposes the balance scan and the activation
// status the UI polls.

import { Router } from "express";
import type { Hex } from "viem";
import { prisma } from "../lib/prisma";
import { ok, err } from "../lib/response";
import { scanWalletBalances } from "../lib/gateway/balances";

export const gatewayRouter = Router();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// ─── GET /v1/wallet/balances ──────────────────────────────────────────────────

gatewayRouter.get("/v1/wallet/balances", async (req, res) => {
  const address = String(req.query.address ?? "");
  if (!ADDRESS_RE.test(address)) {
    return err(res, "Invalid or missing ?address parameter", 400);
  }

  try {
    const balances = await scanWalletBalances(address as Hex);
    return ok(res, {
      address: address.toLowerCase(),
      arc_balance: balances.arcBalance.toString(),
      total: balances.total.toString(),
      chains: balances.chains.map((c) => ({
        chain: c.chainKey,
        name: c.chainName,
        domain: c.domain,
        wallet_balance: c.walletBalance.toString(),
      })),
    });
  } catch (e) {
    console.error("[checkout/balances]", e);
    return err(res, "Failed to scan wallet balances", 502);
  }
});

// ─── GET /checkout/:session_id/sweep/:sweep_id ────────────────────────────────

gatewayRouter.get("/checkout/:session_id/sweep/:sweep_id", async (req, res) => {
  try {
    const session = await prisma.checkoutSession.findUnique({
      where: { sessionId: req.params.session_id as string },
    });
    if (!session) return err(res, "Checkout session not found", 404);

    const sweep = await prisma.sweep.findFirst({
      where: { sweepId: req.params.sweep_id as string, sessionId: session.id },
    });
    if (!sweep) return err(res, "Activation not found", 404);

    const redirectUrl =
      sweep.status === "complete"
        ? session.successUrl.replace("{SESSION_ID}", session.sessionId)
        : null;

    // completeCheckoutSession stamps the session's subscriptionId BEFORE the sweep
    // is flipped to "complete", and this handler read the session first — so a null
    // here on a complete sweep means we read the session a moment too early, not
    // that there is no subscription. One targeted re-read closes that window.
    let subscriptionId = session.subscriptionId;
    if (sweep.status === "complete" && !subscriptionId) {
      const fresh = await prisma.checkoutSession.findUnique({
        where: { id: session.id },
        select: { subscriptionId: true },
      });
      subscriptionId = fresh?.subscriptionId ?? null;
    }

    return ok(res, {
      sweep_id: sweep.sweepId,
      status: sweep.status,
      error: sweep.error,
      activation_tx_hash: sweep.activationTxHash,
      // The chain the funds were actually pulled from, for the confirmation receipt.
      source_chain: sweep.sourceChain,
      // The subscription this activation created. The confirmation page's renewal
      // permissions bind to it rather than to the spent checkout session, so
      // without this the section cannot render after a cross-chain payment.
      subscription_id: subscriptionId,
      redirect_url: redirectUrl,
    });
  } catch (e) {
    console.error("[checkout/sweep/status]", e);
    return err(res, "Failed to load activation status", 500);
  }
});
