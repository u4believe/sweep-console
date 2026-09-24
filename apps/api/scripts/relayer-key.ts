// Create and fund a relayer/delegate key.
//
//   pnpm --filter @sweep/api relayer:key -- new ~/sweepconsole-keys/renewal-delegate.env
//   pnpm --filter @sweep/api relayer:key -- fund 0xNEW…            # dry run
//   pnpm --filter @sweep/api relayer:key -- fund 0xNEW… --send     # actually send
//
// `fund` covers the three source chains AND Arc — see the note on CHAINS.
//
// `new` writes the key to a file at mode 0600 and prints ONLY the address. A
// private key should never reach a terminal, a chat window, a ticket or a shell
// history — the three places it reliably ends up when someone asks for one and
// the answer is printed. Read it out of the file when you paste it into a
// secret manager, and delete the file once it is there.
//
// `fund` moves native gas to that address on every source chain, because a
// delegate pays for its own redeemDelegations. A freshly configured delegate
// with no gas does not fail as a configuration error — it fails as a renewal
// that will not settle, hours later.

import "dotenv/config";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, formatEther, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Arc is in this list, which is not obvious and cost a near-miss to learn: a
// delegate does not only redeem on the source chain, it also submits the CCTP
// mint that lands the money on Arc, and pays for that too. A delegate funded on
// the three source chains and not on Arc redeems successfully and then cannot
// settle. Arc's native gas token is USDC, so `default` there is USDC, not ether.
const CHAINS: Record<string, { id: number; rpc: string; default: string }> = {
  "Base Sepolia": { id: 84532, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org", default: "0.02" },
  "Arbitrum Sepolia": { id: 421614, rpc: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc", default: "0.02" },
  "OP Sepolia": { id: 11155420, rpc: process.env.OPTIMISM_SEPOLIA_RPC_URL ?? "https://sepolia.optimism.io", default: "0.02" },
  "Arc (settlement)": { id: 5042002, rpc: process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network/", default: "10" },
};

const chainFor = (id: number, rpc: string) =>
  defineChain({ id, name: `chain-${id}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

function cmdNew(path: string | undefined) {
  if (!path) { console.error("Usage: relayer:key -- new <file>"); process.exit(1); }
  const target = path.replace(/^~/, process.env.HOME ?? "~");
  if (existsSync(target)) { console.error(`${target} already exists. Refusing to overwrite a key.`); process.exit(1); }

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `# Generated ${new Date().toISOString()}\nRENEWAL_DELEGATE_PRIVATE_KEY=${key}\n`, { mode: 0o600 });

  console.log(`address: ${account.address}`);
  console.log(`written: ${target} (mode 0600)`);
  console.log(`\nNext: fund it, then paste the value into Railway. Read it with:\n  grep RENEWAL_DELEGATE_PRIVATE_KEY ${target}`);
}

async function cmdFund(to: string | undefined, send: boolean, amountEth?: string) {
  if (!to?.startsWith("0x")) { console.error("Usage: relayer:key -- fund <address> [--send] [--amount 0.02]"); process.exit(1); }
  const from = process.env.PLATFORM_PRIVATE_KEY;
  if (!from) { console.error("PLATFORM_PRIVATE_KEY is not set — nothing to send from."); process.exit(1); }
  const funder = privateKeyToAccount((from.startsWith("0x") ? from : `0x${from}`) as Hex);
  console.log(`from ${funder.address}\nto   ${to}${send ? "" : "\n(dry run — pass --send)"}\n`);

  for (const [name, { id, rpc, default: fallback }] of Object.entries(CHAINS)) {
    const value = parseEther(amountEth ?? fallback);
    const chain = chainFor(id, rpc);
    const pub = createPublicClient({ chain, transport: http(rpc) });
    try {
      const [have, already] = await Promise.all([
        pub.getBalance({ address: funder.address }),
        pub.getBalance({ address: to as Address }),
      ]);
      const line = `${name.padEnd(18)} funder ${Number(formatEther(have)).toFixed(4)}  target ${Number(formatEther(already)).toFixed(4)}`;
      void 0;
      if (already >= value) { console.log(`${line}  — already funded, skipping`); continue; }
      if (have < value) { console.log(`${line}  — funder short, skipping`); continue; }
      if (!send) { console.log(`${line}  — would send`); continue; }
      const wallet = createWalletClient({ account: funder, chain, transport: http(rpc) });
      const hash = await wallet.sendTransaction({ to: to as Address, value });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`${line}  — sent ${hash}`);
    } catch (e) {
      console.log(`${name.padEnd(18)} error: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2).filter((a) => a !== "--");
  const amountIdx = rest.indexOf("--amount");
  const amount = amountIdx >= 0 ? rest[amountIdx + 1] : undefined;

  if (cmd === "new") cmdNew(arg);
  else if (cmd === "fund") await cmdFund(arg, rest.includes("--send"), amount);
  else { console.error("Commands: new <file> | fund <address> [--send] [--amount <n>]"); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
