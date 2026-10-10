# What subscribers run into

Everything here happens on the hosted checkout, to the person paying — not to
you. It is listed so you recognise the support ticket when it arrives and can
answer it in one reply.

| What they see | What is happening |
| --- | --- |
| **Not enough USDC** | Checkout checks the balance on the chosen chain before asking for a signature. They top up, or switch to another of Base / Arbitrum / Optimism |
| **Their wallet can't authorize renewals** | Recurring charges need an ERC-7715-capable wallet — MetaMask today. The checkout says so rather than failing at the signature |
| **MetaMask: "couldn't reach permission storage"** | They turn on MetaMask → Settings → Backup and sync, confirm they are signed in and online, and retry. Nothing to fix on your side |
| **Email not verified** | Payment is blocked until they enter the 6-digit code. If it never arrives it is almost always a spam folder |
| **Chain switching** | The wallet must be on the chain being paid from. The checkout switches it for them; they approve the prompt |
| **Cross-chain takes a moment** | CCTP Fast usually settles in under a minute, and the page has to stay open |

## Gas

Paying is **gasless on every chain** — the platform submits each transaction and
covers gas and the bridge fee.

One exception: a wallet's **one-time smart-account setup** on each chain, which
the wallet submits itself and costs the subscriber a few cents. Never charged
again for that chain.
