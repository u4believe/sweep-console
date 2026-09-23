// One place decides whether this process is serving production traffic.
//
// NODE_ENV alone is not a safe answer here. Nothing in this repo sets it: not
// the dev script, not railway.json's start command, not any .env. Its runtime
// value is therefore whatever the host happens to inject — and four security
// decisions hang off it: the session cookie's Secure/SameSite flags, the CORS
// localhost allowance, the Circle webhook IP allowlist, and whether the
// unauthenticated dev routes are mounted at all. An unset variable should not
// be the thing that decides those.
//
// So the default is inverted: this is production unless the process explicitly
// declares otherwise, and only "development" or "test" count as declaring
// otherwise. A missing NODE_ENV now fails closed (production rules) instead of
// open. `pnpm dev` sets NODE_ENV=development so local work is unaffected.
const declared = process.env.NODE_ENV;

export const IS_PRODUCTION = declared !== "development" && declared !== "test";
export const IS_DEV = !IS_PRODUCTION;

// The unauthenticated diagnostics router seeds, deletes and settles real
// subscriptions and can make the relayer move USDC. Being outside production is
// necessary but not sufficient to mount it — an operator has to ask for it by
// name, so that a mis-set NODE_ENV cannot expose it on its own.
export const DEV_ROUTES_ENABLED = IS_DEV && process.env.ENABLE_DEV_ROUTES === "true";
