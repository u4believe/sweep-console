const BASE = process.env.CIRCLE_BASE_URL ?? "https://api.circle.com";

// Per the addendum this should be ARC-TESTNET once Circle user-controlled
// wallets support Arc; ETH-SEPOLIA is the working sandbox default until then.
const CIRCLE_BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? "ETH-SEPOLIA";

function authHeaders(userToken?: string): Record<string, string> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) throw new Error("CIRCLE_API_KEY is not set");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (userToken) headers["X-User-Token"] = userToken;
  return headers;
}

async function circlePost<T>(path: string, body: unknown, userToken?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(userToken),
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(`[circle] POST ${path} → ${res.status}`, JSON.stringify(json).slice(0, 300));
  if (!res.ok) {
    throw new Error(`Circle API error (${res.status}): ${(json as { message?: string }).message ?? JSON.stringify(json)}`);
  }
  return (json as { data: T }).data;
}

async function circleGet<T>(path: string, userToken?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(userToken) });
  const json = await res.json();
  console.log(`[circle] GET ${path} → ${res.status}`, JSON.stringify(json).slice(0, 300));
  if (!res.ok) {
    throw new Error(`Circle API error (${res.status}): ${(json as { message?: string }).message ?? JSON.stringify(json)}`);
  }
  return (json as { data: T }).data;
}

export async function createCircleUser(userId: string): Promise<void> {
  await circlePost("/v1/w3s/users", { userId });
}

export async function getCircleUserToken(
  userId: string
): Promise<{ userToken: string; encryptionKey: string }> {
  return circlePost<{ userToken: string; encryptionKey: string }>(
    "/v1/w3s/users/token",
    { userId }
  );
}

export async function createCircleWalletChallenge(
  userToken: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  // /initialize creates the PIN challenge + wallet in one step (first-time setup only)
  // EOA = standard Externally Owned Account; SCA requires special Circle feature flag
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/initialize",
    { idempotencyKey: randomUUID(), blockchains: [CIRCLE_BLOCKCHAIN], accountType: "EOA" },
    userToken
  );
}

// For users already initialized (have a PIN): create an additional wallet via challenge
export async function createCircleWalletForExistingUser(
  userToken: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/wallets",
    { idempotencyKey: randomUUID(), blockchains: [CIRCLE_BLOCKCHAIN], accountType: "EOA", count: 1 },
    userToken
  );
}

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
  state: string;
}

export async function getCircleWallets(userToken: string): Promise<CircleWallet[]> {
  const data = await circleGet<{ wallets: CircleWallet[] }>("/v1/w3s/user/wallets", userToken);
  return data.wallets ?? [];
}

export interface ChallengeResult {
  challenge: {
    id: string;
    type: string;
    status: string;
    correlationIds: string[];
  };
}

export async function getCircleChallengeStatus(
  userToken: string,
  challengeId: string
): Promise<ChallengeResult> {
  return circleGet<ChallengeResult>(
    `/v1/w3s/user/challenges/${challengeId}`,
    userToken
  );
}

// Fetch a single wallet by ID using platform auth (no user token needed).
// Use this when GET /v1/w3s/user/wallets returns 404 despite a completed challenge.
export async function getCircleWalletById(walletId: string): Promise<CircleWallet | null> {
  try {
    const data = await circleGet<{ wallet: CircleWallet }>(`/v1/w3s/wallets/${walletId}`);
    return data.wallet ?? null;
  } catch {
    return null;
  }
}

export interface TokenBalance {
  token: { id: string; name: string; symbol: string; blockchain: string; decimals: number };
  amount: string;
  updateDate: string;
}

export async function getCircleWalletBalances(walletId: string): Promise<TokenBalance[]> {
  try {
    const data = await circleGet<{ tokenBalances: TokenBalance[] }>(`/v1/w3s/wallets/${walletId}/balances`);
    return data.tokenBalances ?? [];
  } catch {
    return [];
  }
}

// Fetch the ECDSA public key for a given Circle key ID.
// The key is base64-encoded DER (SPKI format); cache it — it never changes per ID.
export async function getWebhookPublicKey(keyId: string): Promise<string> {
  const data = await circleGet<{ publicKey: string; algorithm: string }>(
    `/v2/notifications/publicKey/${keyId}`
  );
  return data.publicKey; // base64-encoded DER
}

export async function registerWebhookSubscription(webhookUrl: string): Promise<{ id: string; endpoint: string }> {
  return circlePost<{ id: string; endpoint: string }>("/v2/notifications/subscriptions", {
    endpoint: webhookUrl,
    notificationTypes: ["transactions.inbound", "transactions.outbound"],
  });
}

export async function createCircleTransferChallenge(
  userToken: string,
  walletId: string,
  tokenId: string,
  destinationAddress: string,
  amount: string
): Promise<{ challengeId: string }> {
  const { randomUUID } = await import("crypto");
  return circlePost<{ challengeId: string }>(
    "/v1/w3s/user/transactions/transfer",
    {
      idempotencyKey: randomUUID(),
      walletId,
      tokenId,
      destinationAddress,
      amounts: [amount],
      // Circle's transfer endpoint takes `feeLevel` as a top-level field (dynamic
      // gas estimation). Without it, Circle demands explicit gasPrice/gasLimit and
      // rejects the request — that's the "API parameter invalid" on withdrawal.
      feeLevel: "MEDIUM",
    },
    userToken
  );
}
