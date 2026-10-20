/**
 * A viem account whose private key lives in a KMS and never reaches this
 * process.
 *
 * WHY THE PLUMBING IS THE WORK
 *
 * A KMS signs a 32-byte digest and hands back ASN.1 DER containing r and s.
 * Ethereum needs r, s AND a recovery id, and it requires s to be in the lower
 * half of the curve order (EIP-2). A KMS provides neither of those last two,
 * so three things have to happen here:
 *
 *   1. unwrap DER into r and s
 *   2. if s is in the upper half, replace it with n - s AND flip the recovery
 *      bit — doing one without the other produces a signature that recovers to
 *      the wrong address
 *   3. derive the recovery id by trying both and keeping whichever recovers to
 *      the address we know the key has
 *
 * Step 2 is the one that bites. Get the pairing wrong and roughly half of all
 * signatures still verify, so it passes a smoke test and then fails
 * intermittently in a money path — which is why this module is written against
 * an injected signer and tested with a local key that deliberately withholds
 * the recovery id, rather than first against a cloud account.
 *
 * WHAT THE OWNER KEY HAS TO DO HERE
 *
 * It wears two hats in the settlement and delegate paths, and they need
 * different methods:
 *
 *   · MSCA owner — signs UserOperations, so signMessage, and `sign` for the
 *     raw-digest path the Circle SDK takes for typed data
 *   · submitter — sends handleOps as an ORDINARY transaction, so
 *     signTransaction, which viem's toAccount() does not provide for free
 *
 * All four are implemented. Miss signTransaction and the MSCA signs fine while
 * nothing can be submitted, which is a confusing place to discover a gap.
 */

import {
  hashMessage,
  hashTypedData,
  getAddress,
  keccak256,
  recoverAddress,
  serializeTransaction,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
  type SignableMessage,
  type TransactionSerializable,
} from "viem";
import { toAccount } from "viem/accounts";

/** The order of the secp256k1 curve. */
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = CURVE_N / 2n;

/**
 * What a KMS gives us: r and s over a digest, and nothing else.
 *
 * Deliberately the smallest possible surface. AWS KMS, Google Cloud KMS, an
 * HSM behind PKCS#11 and a hosted signer all reduce to this, so a provider is
 * an adapter of a few lines rather than a rewrite — and the part that is easy
 * to get wrong is written once.
 *
 * Returning raw DER is allowed because that is what AWS hands back; a provider
 * that returns r and s already can pass them directly.
 */
export type RemoteSigner = {
  /** The address of the key, read once from its public key. */
  address: Address;
  /** Sign a 32-byte digest. Return DER, or r and s directly. */
  signDigest(digest: Hex): Promise<Hex | { r: bigint; s: bigint }>;
};

/**
 * Pull r and s out of an ASN.1 DER ECDSA signature.
 *
 * SEQUENCE { INTEGER r, INTEGER s } — walked by hand rather than with an ASN.1
 * library, because this is the only DER this codebase will ever parse and a
 * dependency for thirty lines is a worse trade than the thirty lines.
 *
 * DER INTEGERs are signed and big-endian, so a value whose top bit is set
 * carries a leading zero byte that has to come off.
 */
export function derToRS(der: Hex): { r: bigint; s: bigint } {
  const bytes = Buffer.from(der.slice(2), "hex");
  let i = 0;
  if (bytes[i++] !== 0x30) throw new Error("KMS signature is not a DER SEQUENCE");
  // Length byte; long form (0x81) appears for sequences over 127 bytes.
  if (bytes[i] === 0x81) i += 2;
  else i += 1;

  const readInt = (): bigint => {
    if (bytes[i++] !== 0x02) throw new Error("KMS signature: expected a DER INTEGER");
    const len = bytes[i++]!;
    const slice = bytes.subarray(i, i + len);
    i += len;
    return BigInt(`0x${slice.toString("hex")}`);
  };

  const r = readInt();
  const s = readInt();
  return { r, s };
}

/**
 * Turn r and s into an Ethereum signature, normalising s and finding v.
 *
 * `expected` is the address the key is known to have; it is what makes the
 * recovery id discoverable rather than guessed. If neither candidate recovers
 * to it, something is wrong with the key or the digest and this says so rather
 * than returning a signature that will be rejected on chain.
 */
export async function toEthSignature(
  digest: Hex,
  r: bigint,
  s: bigint,
  expected: Address
): Promise<Hex> {
  // EIP-2: s must be in the lower half. Flipping s flips the recovery bit, so
  // the two must move together — this is the step that fails silently when it
  // is done by halves.
  const normalisedS = s > HALF_N ? CURVE_N - s : s;

  const rHex = r.toString(16).padStart(64, "0");
  const sHex = normalisedS.toString(16).padStart(64, "0");

  for (const v of [27, 28] as const) {
    const signature = `0x${rHex}${sHex}${v.toString(16)}` as Hex;
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() === expected.toLowerCase()) return signature;
  }

  throw new Error(
    `neither recovery id recovers ${expected} from this signature — the KMS key does not ` +
      `match the address it is configured with, or the digest was altered in transit`
  );
}

/**
 * Wrap a RemoteSigner as a viem LocalAccount.
 *
 * `type: "local"` is what the Circle SDK and viem's account-abstraction helpers
 * check for; nothing about it implies the key is local, only that signing is
 * synchronous from their point of view.
 */
export function toKmsAccount(signer: RemoteSigner): LocalAccount {
  const sign = async ({ hash }: { hash: Hex }): Promise<Hex> => {
    const out = await signer.signDigest(hash);
    const { r, s } = typeof out === "string" ? derToRS(out) : out;
    return toEthSignature(hash, r, s, signer.address);
  };

  return toAccount({
    address: signer.address,

    /// Raw digest. The Circle SDK's signTypedData path needs this, and
    /// viem's toAccount() does not provide it unless it is passed in.
    sign,

    async signMessage({ message }: { message: SignableMessage }) {
      return sign({ hash: hashMessage(message) });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTypedData(typedData: any) {
      return sign({ hash: hashTypedData(typedData) });
    },

    /**
     * Needed because the owner is also the submitter — it sends handleOps as an
     * ordinary transaction. Signed the way viem signs one: serialize without a
     * signature, hash, sign, then serialize again with it.
     */
    async signTransaction(transaction: TransactionSerializable) {
      const signature = await sign({ hash: keccak256(serializeTransaction(transaction)) });
      const r = `0x${signature.slice(2, 66)}` as Hex;
      const s = `0x${signature.slice(66, 130)}` as Hex;
      const v = BigInt(`0x${signature.slice(130, 132)}`);
      return serializeTransaction(transaction, {
        r,
        s,
        v,
        yParity: v === 28n ? 1 : 0,
      });
    },
  }) as LocalAccount;
}

/**
 * A RemoteSigner backed by a local private key, for testing the plumbing.
 *
 * It withholds the recovery id on purpose — returning only r and s, exactly as
 * a KMS does — so the normalisation and recovery logic above is exercised for
 * real without any cloud account existing. If this signer's output verifies,
 * a provider adapter is the only thing left to write.
 *
 * NOT for production: the key is in the process, which is the whole thing a KMS
 * is for. It throws if NODE_ENV says production.
 */
export async function localTestSigner(privateKey: Hex): Promise<RemoteSigner> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("localTestSigner is a test double and must not run in production");
  }
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    async signDigest(digest: Hex) {
      const sig = await account.sign({ hash: digest });
      // Drop v, and push s into the upper half half the time, so the caller has
      // to do the work a real KMS forces on it.
      const r = BigInt(`0x${sig.slice(2, 66)}`);
      let s = BigInt(`0x${sig.slice(66, 130)}`);
      if (BigInt(digest) % 2n === 0n && s < HALF_N) s = CURVE_N - s;
      return { r, s };
    },
  };
}

/** Hex for a digest, so callers need not import toHex just for this. */
export const digestOf = toHex;


/**
 * Resolve a KMS-backed signer for a named role from configuration.
 *
 * No provider adapter is wired yet — that needs an account and a decision, and
 * the SDK differs by provider. What is here is the dispatch and the shape, so
 * adding one is a function body rather than a redesign.
 *
 * Two variables per role, for example for the hosted delegate:
 *
 *   KMS_PROVIDER=aws                       (aws | gcp | turnkey)
 *   KMS_KEY_HOSTED=<the provider's key id>
 *   KMS_ADDRESS_HOSTED=0x…                 (the key's Ethereum address)
 *
 * THE ADDRESS IS CONFIGURED, NOT FETCHED, on purpose. Reading a public key is
 * an async call, and every caller of getRelayerAccount() is synchronous — an
 * address in config keeps it that way. It is not taken on trust either:
 * toEthSignature refuses to return a signature that does not recover to this
 * address, so a wrong one fails loudly at the first signature rather than
 * producing something a chain will reject for no stated reason.
 *
 * ADDING A PROVIDER
 *
 *   aws      IMPLEMENTED below. Create the key with KeySpec
 *            ECC_SECG_P256K1 and KeyUsage SIGN_VERIFY. Sign with
 *            MessageType: "DIGEST" and SigningAlgorithm:
 *            "ECDSA_SHA_256"; the response's Signature is the DER this
 *            module already parses. GetPublicKey once to learn the
 *            address for KMS_ADDRESS_*.
 *
 *   gcp      @google-cloud/kms. Key purpose ASYMMETRIC_SIGN, algorithm
 *            EC_SIGN_SECP256K1_SHA256. asymmetricSign returns DER in
 *            `signature`.
 *
 *   turnkey  @turnkey/sdk-server. Returns r and s directly, so return
 *            them as { r, s } and the DER path is skipped entirely.
 */
/// Logged once per role, not per signature.
const announced = new Set<string>();

export function kmsSignerFromEnv(role: "hosted" | "external" | "settlement"): RemoteSigner | null {
  const provider = process.env.KMS_PROVIDER;
  if (!provider) return null;

  const suffix = role.toUpperCase();
  const keyId = process.env[`KMS_KEY_${suffix}`];
  const address = process.env[`KMS_ADDRESS_${suffix}`] as Address | undefined;

  /**
   * KMS is opted into PER ROLE, not for the whole process.
   *
   * This used to throw whenever KMS_PROVIDER was set and a role's key was
   * absent. But KMS_PROVIDER is one switch and the roles are four, so
   * configuring KMS for settlement alone made getRelayerAccount("hosted") and
   * ("external") throw — and with them every renewal, every external redeem
   * and the Arc relayer, which all go through it. A key management change for
   * one account stopped three others from signing at all.
   *
   * Neither key present means this role was never meant to be on KMS: use its
   * local key, and say so once at startup so it is visible rather than
   * assumed.
   *
   * ONE key present is different — that is a half-finished configuration, and
   * falling back there would silently use the key KMS was brought in to
   * replace. That still throws.
   */
  if (!keyId && !address) {
    if (!announced.has(role)) {
      announced.add(role);
      console.log(
        `[kms] ${role} uses its local key — KMS_PROVIDER=${provider} is set but ` +
          `KMS_KEY_${suffix} is not, so KMS was not intended for this role`
      );
    }
    return null;
  }

  if (!keyId || !address) {
    throw new Error(
      `KMS_PROVIDER=${provider} and ${keyId ? `KMS_KEY_${suffix}` : `KMS_ADDRESS_${suffix}`} are set ` +
        `but ${keyId ? `KMS_ADDRESS_${suffix}` : `KMS_KEY_${suffix}`} is not — refusing to fall back to ` +
        `a local key for ${role}, because silently using the key a KMS was configured to replace is ` +
        `the one outcome nobody wants. Set both, or neither.`
    );
  }

  if (provider === "aws") return awsKmsSigner(keyId, address);

  throw new Error(
    `no KMS adapter is implemented for KMS_PROVIDER=${provider}. The signer interface and all the ` +
      `signature handling are ready — see the notes above kmsSignerFromEnv for what each provider's ` +
      `adapter has to do. Supported today: aws.`
  );
}

/**
 * One KMS client per process.
 *
 * The SDK pools connections and resolves credentials on construction, so
 * building one per signature would add a credential lookup to every redeem.
 * Imported lazily so a deployment with no KMS configured never loads it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kmsClient: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function awsClient(): Promise<any> {
  if (kmsClient) return kmsClient;
  const { KMSClient } = await import("@aws-sdk/client-kms");
  const region = process.env.KMS_REGION ?? process.env.AWS_REGION;
  if (!region) {
    throw new Error("KMS_PROVIDER=aws needs a region — set KMS_REGION or AWS_REGION");
  }
  kmsClient = new KMSClient({ region });
  return kmsClient;
}

/**
 * AWS KMS, signing a digest with a secp256k1 key.
 *
 * MessageType "DIGEST" matters: the default is "RAW", which would have KMS
 * hash the 32 bytes again and sign the wrong thing — producing a valid
 * signature over the wrong message, which recovers to no address we know and
 * so fails in toEthSignature rather than silently. SigningAlgorithm is
 * ECDSA_SHA_256 even though nothing is being hashed here; it selects the
 * curve's signature scheme, not a hash step.
 *
 * The response's Signature is ASN.1 DER, which derToRS already handles, and
 * the recovery id and low-s normalisation happen in toEthSignature. So this
 * adapter is genuinely only the transport.
 */
function awsKmsSigner(keyId: string, address: Address): RemoteSigner {
  return {
    address,
    async signDigest(digest: Hex): Promise<Hex> {
      const { SignCommand } = await import("@aws-sdk/client-kms");
      const client = await awsClient();
      const out = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: Buffer.from(digest.slice(2), "hex"),
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        })
      );
      if (!out.Signature) {
        throw new Error(`AWS KMS returned no signature for key ${keyId}`);
      }
      return `0x${Buffer.from(out.Signature).toString("hex")}` as Hex;
    },
  };
}

/**
 * The Ethereum address of an AWS KMS secp256k1 key, for KMS_ADDRESS_*.
 *
 * GetPublicKey returns a DER SubjectPublicKeyInfo wrapping an uncompressed
 * point. The address is the last 20 bytes of keccak256 over the 64 bytes of
 * X||Y — note that the leading 0x04 uncompressed-point marker is NOT hashed,
 * which is the usual way this comes out one byte wrong.
 *
 * Called by a script, not on a request path: the address belongs in config so
 * that account construction stays synchronous.
 */
export async function awsKmsAddress(keyId: string): Promise<Address> {
  const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
  const client = await awsClient();
  const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!out.PublicKey) throw new Error(`AWS KMS returned no public key for ${keyId}`);

  const der = Buffer.from(out.PublicKey);
  // The uncompressed point is the final 65 bytes, starting with 0x04. Found by
  // position rather than by walking the SPKI structure, because the prefix
  // varies with how the curve is named and the tail does not.
  const marker = der.lastIndexOf(0x04);
  const point = der.subarray(marker, marker + 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("could not find an uncompressed EC point in the KMS public key");
  }
  const hash = keccak256(`0x${point.subarray(1).toString("hex")}` as Hex);
  return getAddress(`0x${hash.slice(-40)}`);
}
