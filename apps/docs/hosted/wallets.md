# Wallets & email

## Email

Email is the **identity anchor** for a subscriber on each merchant. The wallet
is the payment method attached to it.

- **Your subscribers** verify with a 6-digit one-time code before paying. A
  returning subscriber may not be asked again.
- **You** verify your own account via a link emailed at sign-up, where you set a
  password. Signing up with Google skips that step.

## Wallets

- **No auto-connect.** Connecting a wallet is always an explicit action.
- **A new subscriber** sees a Connect Wallet button after email verification.
- **A returning subscriber** — the wallet they used with you before is
  recognised once they verify their email.
- **Using a different wallet** — they disconnect and pick another. The old
  wallet's permission is revoked when the **new subscription completes** and
  replaces the old one, not when the new wallet is connected. Between those two
  moments both grants are live, which is why the checkout also offers to revoke
  the old one first.

## Recurring needs ERC-7715

Recurring charges need an ERC-7715-capable wallet — MetaMask today. The grant is
what authorizes every renewal after the first, and a wallet without it cannot
subscribe. The checkout says so up front rather than failing at the signature.
