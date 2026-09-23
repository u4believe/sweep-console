import { errorFrom, SweepError } from "./errors.js";
import type {
  Charge, CreateChargeParams, CreateMandateParams, Mandate, Usdc,
} from "./types.js";

// The API is its own origin, not a path under the website. www.sweepconsole.xyz
// is the Vercel-hosted front end and answers every path with the app shell, so
// pointing a client there yields a 200 full of HTML — see `parse` below, which
// exists because that mistake is otherwise diagnosed by JSON.parse.
const DEFAULT_BASE_URL = "https://sweepapi-production-28e1.up.railway.app";

export interface SweepOptions {
  /** Override for self-hosting or a tunnel. Defaults to the hosted API. */
  baseUrl?: string;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /**
   * How many times to retry a request that failed in a way that cannot have
   * been applied — a network error, a 429, a 5xx. Default 2.
   *
   * Charges are exempt from the "cannot have been applied" reasoning, but they
   * carry an Idempotency-Key, which is what makes retrying them safe.
   */
  maxRetries?: number;
}

export class Sweep {
  readonly mandates: Mandates;
  readonly charges: Charges;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(apiKey: string, options: SweepOptions = {}) {
    if (!apiKey) {
      throw new Error(
        "Sweep: an API key is required. Create one in the portal under API Keys, " +
          "and read it from the environment — never commit it."
      );
    }
    if (apiKey.startsWith("live_")) {
      // Better here than as a 403 three calls later.
      throw new Error("Sweep: live API keys are not issued yet. Use your test_ key.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.mandates = new Mandates(this);
    this.charges = new Charges(this);
  }

  /**
   * A 200 that is not JSON almost always means `baseUrl` is pointing at the web
   * app rather than the API — a single-page app answers every path with its
   * index.html, so the request "succeeds" and then dies in JSON.parse with
   * `Unexpected token '<'`. Say that, rather than letting the parser say it.
   */
  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
      throw new SweepError(
        looksLikeHtml
          ? `Expected JSON from ${res.url} but got an HTML page. This usually means baseUrl points at the ` +
            `website rather than the API — check the API base URL in your Sweep portal.`
          : `Expected JSON from ${res.url} but got ${res.headers.get("content-type") ?? "an unknown type"}.`,
        { code: "invalid_response", status: res.status }
      );
    }
  }

  /** @internal */
  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | number | undefined>; idempotencyKey?: string } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": "sweepconsole-node/0.1.0",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.ok) return (await this.parse<T>(res)) as T;

        // 5xx and 429 may succeed on a retry; a 4xx is a decision, not a blip.
        if ((res.status >= 500 || res.status === 429) && attempt < this.maxRetries) {
          lastError = errorFrom(res.status, await safeJson(res));
          continue;
        }
        throw errorFrom(res.status, await safeJson(res));
      } catch (e) {
        if (e instanceof SweepError) throw e;
        // Network-level: DNS, connection reset, timeout.
        lastError = e;
        if (attempt >= this.maxRetries) {
          throw new SweepError(
            `Could not reach the Sweep API: ${e instanceof Error ? e.message : String(e)}`,
            { code: "network_error", status: 0 }
          );
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

class Mandates {
  constructor(private readonly sweep: Sweep) {}

  /**
   * Create a pending mandate and get back the URL to send the payer to.
   *
   * Nothing is authorized yet. The mandate becomes chargeable when the payer
   * signs and `mandate.authorized` fires — start your billing clock on that
   * webhook, not on the redirect, which they can close.
   */
  async create(params: CreateMandateParams): Promise<Mandate> {
    return toMandate(
      await this.sweep.request("POST", "/v1/mandates", {
        body: {
          external_ref: params.externalRef,
          email: params.email,
          max_amount: params.maxAmount,
          interval: params.interval,
          chains: params.chains,
          expires_at: params.expiresAt.toISOString(),
          return_url: params.returnUrl,
          metadata: params.metadata,
        },
      })
    );
  }

  async retrieve(id: string): Promise<Mandate> {
    return toMandate(await this.sweep.request("GET", `/v1/mandates/${encodeURIComponent(id)}`));
  }

  async list(params: { status?: string; limit?: number } = {}): Promise<Mandate[]> {
    const body = await this.sweep.request<{ data?: unknown[] } | unknown[]>("GET", "/v1/mandates", {
      query: { status: params.status, limit: params.limit },
    });
    return rows(body).map(toMandate);
  }

  /**
   * Stop honouring a mandate. Idempotent, and fires `mandate.revoked`.
   *
   * This is a decision recorded on our side, not a cryptographic one: the
   * grants stay signed on chain, because only the payer's wallet can disable
   * them. We stop redeeming them.
   */
  async revoke(id: string): Promise<Mandate> {
    return toMandate(await this.sweep.request("DELETE", `/v1/mandates/${encodeURIComponent(id)}`));
  }
}

class Charges {
  constructor(private readonly sweep: Sweep) {}

  /**
   * Collect one pull against a mandate.
   *
   * Answers 202, never 200: the charge row exists immediately, the money
   * arrives seconds to minutes later. Learn the outcome from
   * `charge.succeeded` / `charge.failed`, or by polling `retrieve`.
   *
   * `idempotencyKey` is required by this signature rather than by a runtime
   * 400. Use a natural key — an invoice id, or `${userId}:${period}` — so that
   * a retry after a timeout cannot collect twice.
   */
  async create(params: CreateChargeParams, opts: { idempotencyKey: string }): Promise<Charge> {
    if (!opts?.idempotencyKey?.trim()) {
      throw new Error(
        "Sweep: charges.create needs an idempotencyKey. Use a natural one — an invoice id, " +
          "or `${userId}:${period}` — so a retry collects once rather than twice."
      );
    }
    return toCharge(
      await this.sweep.request("POST", "/v1/charges", {
        idempotencyKey: opts.idempotencyKey.trim(),
        body: {
          mandate: typeof params.mandate === "string" ? params.mandate : params.mandate.id,
          amount: params.amount,
          description: params.description,
          metadata: params.metadata,
        },
      })
    );
  }

  async retrieve(id: string): Promise<Charge> {
    return toCharge(await this.sweep.request("GET", `/v1/charges/${encodeURIComponent(id)}`));
  }

  async list(params: { mandate?: string; status?: string; limit?: number } = {}): Promise<Charge[]> {
    const body = await this.sweep.request<{ data?: unknown[] } | unknown[]>("GET", "/v1/charges", {
      query: { mandate: params.mandate, status: params.status, limit: params.limit },
    });
    return rows(body).map(toCharge);
  }
}

// ─── wire → typed ─────────────────────────────────────────────────────────────

function rows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const d = (body as { data?: unknown })?.data;
  return Array.isArray(d) ? d : [];
}

function date(v: unknown): Date {
  return new Date(String(v));
}
function maybeDate(v: unknown): Date | null {
  return v == null ? null : new Date(String(v));
}

function toMandate(raw: any): Mandate {
  return {
    id: raw.id,
    mode: "external",
    status: raw.status,
    externalRef: raw.external_ref,
    email: raw.email ?? null,
    walletAddress: raw.wallet_address ?? null,
    maxAmount: raw.max_amount as Usdc,
    currency: "USDC",
    interval: raw.interval,
    periodDuration: raw.period_duration,
    chains: raw.chains ?? [],
    testMode: !!raw.test_mode,
    expiresAt: date(raw.expires_at),
    authorizationUrl: raw.authorization_url ?? null,
    authorizationUrlExpiresAt: date(raw.authorization_url_expires_at),
    authorizedAt: maybeDate(raw.authorized_at),
    revokedAt: maybeDate(raw.revoked_at),
    metadata: raw.metadata ?? null,
    createdAt: date(raw.created_at),
  };
}

function toCharge(raw: any): Charge {
  return {
    id: raw.id,
    mandate: raw.mandate,
    status: raw.status,
    amount: raw.amount as Usdc,
    currency: raw.currency ?? "USDC",
    description: raw.description ?? null,
    externalRef: raw.external_ref,
    metadata: raw.metadata ?? null,
    testMode: !!raw.test_mode,
    sourceChain: raw.source_chain ?? null,
    settlementChain: raw.settlement_chain ?? null,
    txHash: raw.tx_hash ?? null,
    failureReason: raw.failure_reason ?? null,
    createdAt: date(raw.created_at),
    settledAt: maybeDate(raw.settled_at),
  };
}

function safeJson(res: Response): Promise<any> {
  return res.json().catch(() => null);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
