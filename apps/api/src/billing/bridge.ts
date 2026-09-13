// Driving a CCTP bridge to completion, for whatever owns it.
//
// A source-chain collection is two phases separated by Circle's attestation:
//   "pulled"  — funds are with the relayer; the source chain is done with them
//   "burned"  — burnt toward Arc; waiting on Iris
//   "minted"  — landed on Arc in the recipient's hands
//
// Every step is persisted before the next begins, so a failure anywhere resumes
// from where it stopped and the subscriber's period is NEVER pulled twice. That
// property is the whole reason BridgeTransfer exists, and it is why this module
// refuses to re-pull under any circumstances.
//
// What it deliberately does NOT know is what the money was for. It used to take a
// Subscription and advance its billing period, which meant the rail could not use
// it: a charge has no subscription and no period to roll. So settlement is a
// callback now. The bridge moves the money; the caller decides what "settled"
// means — advance a period and write a renewal Payment, or complete a Charge.
//
// The settle callback OWNS marking the bridge row "minted", because it should
// happen in the same transaction as the caller's own records. If it were done
// here, a crash between the two would leave a minted bridge with nothing to show
// for it.

import type { Address, Hex } from "viem";
import type { BridgeTransfer } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { chainKeyForId, getSourceChain, ARC_DOMAIN } from "../lib/gateway/chains";
import { relayerBridgeToArc } from "../lib/chain/delegation";
import { fetchAttestation, getTokenMessenger, receiveOnArc } from "../lib/gateway/cctp";

/// Called once the mint lands on Arc. Must record whatever the caller considers
/// settlement AND mark the bridge row minted, atomically.
///
/// The hash is NULLABLE, and that is not the same as "no mint". Circle runs
/// auto-relayers that deliver an attested message on sight, so we routinely lose
/// that race — the win condition, since the money arrived. When it happens the
/// only way to name their transaction is an eth_getLogs lookup, and an RPC that
/// does not serve logs leaves us certain the funds landed (usedNonces says so)
/// and unable to cite the transaction. Settle anyway: a payment that arrived must
/// not read as pending because of a missing reference.
export type SettleBridge = (mintTxHash: Hex | null) => Promise<void>;

/// The three real outcomes of driving a bridge, which a nullable hash could not
/// express: settled with proof, settled without a reference, and not yet.
export type BridgeResult =
  | { settled: true; mintTxHash: Hex | null }
  | { settled: false };

/// Fetch the burn's attestation and mint on Arc, then hand off to `settle`.
/// Returns `{ settled: false }` when Iris isn't ready yet — the row stays "burned"
/// and the next pass resumes it. Only a real mint failure throws.
async function mintAndSettle(bridge: BridgeTransfer, settle: SettleBridge): Promise<BridgeResult> {
  if (!bridge.burnTxHash) throw new Error(`bridge ${bridge.id} has no burnTxHash`);
  let att;
  try {
    att = await fetchAttestation(bridge.sourceDomain, bridge.burnTxHash as Hex, {
      timeoutMs: 90_000,
      pollMs: 8_000,
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("Timed out")) {
      console.log(`[bridge] ${bridge.burnTxHash} attestation pending — will resume`);
      return { settled: false };
    }
    throw e;
  }
  const mintTxHash = await receiveOnArc(att);
  await settle(mintTxHash);
  return { settled: true, mintTxHash };
}

/// Drive a bridge from whatever phase it is in to a mint on Arc.
///
/// Safe to call on a row in any non-terminal state, and safe to call repeatedly —
/// that is exactly what the resume passes do.
export async function advanceBridge(bridge: BridgeTransfer, settle: SettleBridge): Promise<BridgeResult> {
  let b = bridge;
  if (b.status === "pulled") {
    const chainKey = chainKeyForId(b.chainId);
    if (!chainKey || chainKey === "arc") throw new Error(`bridge ${b.id} has a non-source chain ${b.chainId}`);
    const source = getSourceChain(chainKey);
    const burn = await relayerBridgeToArc({
      chainId: b.chainId,
      token: source.usdc,
      tokenMessenger: getTokenMessenger(chainKey),
      amount: b.bridgedAmount,
      destinationDomain: ARC_DOMAIN,
      mintRecipient: b.mintRecipient as Address,
      // Fast (soft finality, small maxFee) so a collection settles in seconds
      // rather than minutes. CCTP_RENEWAL_SPEED=standard trades that for the
      // free hard-finality path.
      speed: process.env.CCTP_RENEWAL_SPEED === "standard" ? "standard" : "fast",
    });
    b = await prisma.bridgeTransfer.update({
      where: { id: b.id },
      data: { status: "burned", burnTxHash: burn.burnTxHash },
    });
  }
  return mintAndSettle(b, settle);
}
