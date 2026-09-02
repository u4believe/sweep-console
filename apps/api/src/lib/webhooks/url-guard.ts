// Where a webhook may be delivered.
//
// Registering an endpoint makes THIS server issue an HTTP request to an address
// a merchant chose. Without a check that is server-side request forgery: a
// signed-up merchant could point an endpoint at 127.0.0.1, at 10.x, or at the
// cloud metadata service on 169.254.169.254, and our infrastructure would dial
// it. The response body is never stored, but `responseStatus` and the
// connection error are — and "connection refused" vs "timed out" vs "403" is
// exactly the oracle needed to map an internal network from outside it.
//
// So a destination must be a public http(s) address, and it is checked TWICE:
// once when the endpoint is registered, and again immediately before every
// delivery. Both, because DNS is not a promise — a name that resolved to a
// public address at registration can resolve to 169.254.169.254 an hour later.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/// Local development points endpoints at http://localhost. This flag is the one
/// way to permit both plaintext http and a private destination. Opt in
/// explicitly; it is never the default, and must never be set in production.
function privateAllowed(): boolean {
  return process.env.WEBHOOK_ALLOW_PRIVATE === "true";
}

export class WebhookUrlError extends Error {}

/// Ranges that must never be dialled on behalf of a merchant.
function isBlockedIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true;                          // "this network"
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 192 && b === 0) return true;             // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                         // multicast + reserved + broadcast
  return false;
}

/// Expands any IPv6 spelling into its eight 16-bit groups, so range checks
/// cannot be dodged by writing the same address a different way.
function expandIPv6(ip: string): number[] | null {
  let v = ip.toLowerCase().split("%")[0]!; // drop any zone index

  // A dotted-quad tail (::ffff:127.0.0.1) is the same address as ::ffff:7f00:1,
  // and Node's URL parser will hand us either spelling. Fold it to hex first.
  const dotted = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const q = dotted[2]!.split(".").map(Number);
    if (q.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    v = `${dotted[1]!}${(((q[0]! << 8) | q[1]!) >>> 0).toString(16)}:${(((q[2]! << 8) | q[3]!) >>> 0).toString(16)}`;
  }

  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter((x) => x !== "") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":").filter((x) => x !== "") : [];

  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  }

  const nums = groups.map((g) => parseInt(g, 16));
  if (nums.length !== 8 || nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

function isBlockedIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;

  const leadingZeros = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) carry a v4
  // address inside a v6 one — judge them by what they actually reach. This also
  // covers ::1 and ::, which fold to 0.0.0.1 and 0.0.0.0.
  if (leadingZeros && (g[5] === 0xffff || g[5] === 0)) return isBlockedIPv4(v4From(g[6]!, g[7]!));
  // NAT64 (64:ff9b::/96) is another v4 tunnel.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIPv4(v4From(g[6]!, g[7]!));
  }

  const head = g[0]!;
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function v4From(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIPv4(ip);
  if (family === 6) return isBlockedIPv6(ip);
  return true; // not an address we can reason about — refuse
}

/**
 * Throws WebhookUrlError unless `raw` is somewhere we are willing to POST.
 *
 * Resolves the hostname and checks EVERY address it returns: a name with one
 * public A record and one private one is a rebinding attack with extra steps.
 */
export async function assertDeliverableUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError("That isn't a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WebhookUrlError("Webhook endpoints must be https:// URLs.");
  }
  // TLS is required. A delivery body carries subscriber emails, wallet
  // addresses, amounts and subscription ids, and the signature proves only that
  // WE sent it — it does not hide any of it from the network in between. The
  // dev escape hatch below is the only exception, for http://localhost.
  if (url.protocol === "http:" && !privateAllowed()) {
    throw new WebhookUrlError(
      "Webhook endpoints must use https://. Deliveries carry subscriber and payment " +
        "data, and the signature authenticates them without encrypting them."
    );
  }
  if (url.username || url.password) {
    // Credentials in a URL end up in logs, and we would replay them on every
    // delivery. Signature verification is the auth mechanism here.
    throw new WebhookUrlError("Remove the username and password from the URL — deliveries are authenticated by signature.");
  }

  if (privateAllowed()) return url;

  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new WebhookUrlError(privateRefusal(host));
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new WebhookUrlError(`We couldn't resolve ${host}. Check the hostname and try again.`);
  }
  if (addresses.length === 0) throw new WebhookUrlError(`We couldn't resolve ${host}.`);

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new WebhookUrlError(privateRefusal(`${host} (${address})`));
  }
  return url;
}

function privateRefusal(where: string): string {
  return (
    `${where} is a private or loopback address. Webhook endpoints must be reachable ` +
    `on the public internet — use a tunnel like ngrok to receive events locally.`
  );
}
