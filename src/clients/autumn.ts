import { Autumn } from "autumn-js";
import type { CreateFeatureParams, UpdateFeatureParams } from "autumn-js";
import { DEFAULT_AUTUMN_API_URL } from "../config/constants.ts";
import { readAuth } from "../config/storage.ts";
import type { SummerAuth, SummerUser } from "../domain/types.ts";
import { log } from "../logging/logger.ts";

export type AutumnFeature = {
  id: string;
  name?: string;
  type?: string;
  archived?: boolean;
};

export type TrackTokensAtParams = {
  customerId: string;
  featureId: string;
  modelId: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
  /** Enqueue for async processing (202, no balance in response) — gentle for bulk backfill. */
  async?: boolean;
};

/** Map our camelCase params to Autumn's snake_case track_tokens body (single + batch share this). */
function trackTokensBody(params: TrackTokensAtParams) {
  return {
    customer_id: params.customerId,
    feature_id: params.featureId,
    model_id: params.modelId,
    timestamp: params.timestamp,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    cache_read_tokens: params.cacheReadTokens,
    cache_write_tokens: params.cacheWriteTokens,
    reasoning_tokens: params.reasoningTokens,
    properties: params.properties,
    idempotency_key: params.idempotencyKey,
    async: params.async
  };
}

/**
 * Was a request rejected because the OAuth access token is expired/invalid?
 * Autumn surfaces this as HTTP 401 (`RecaseError` / "Invalid or expired access token").
 */
function isAuthError(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; code?: string; body?: string; message?: string };
  const text = `${err?.body ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return (
    err?.statusCode === 401 ||
    err?.status === 401 ||
    text.includes("(401)") ||
    text.includes("expired access token") ||
    text.includes("invalid or expired")
  );
}

// Dedupe concurrent refreshes across all client instances in this process: refresh tokens
// can be single-use/rotating, so two pollers refreshing at once would invalidate each other.
let sharedRefresh: Promise<SummerAuth> | null = null;
async function refreshSharedAuth(auth: SummerAuth): Promise<SummerAuth> {
  if (!sharedRefresh) {
    // Lazy import to avoid a circular dependency (oauth.ts imports AutumnClient).
    sharedRefresh = import("../auth/oauth.ts")
      .then(({ refreshAuth }) => refreshAuth(auth))
      .finally(() => {
        sharedRefresh = null;
      });
  }
  return sharedRefresh;
}

export class AutumnClient {
  private readonly apiUrl: string;
  private auth: SummerAuth;
  private token: string;
  private sdk: Autumn;

  constructor(auth: Pick<SummerAuth, "accessToken" | "apiUrl"> & Partial<SummerAuth>) {
    // An explicit env var (set by the `d`/`dl` scripts) wins, so the chosen Autumn is authoritative
    // even if the stored auth was minted against a different instance; else the stored/default URL.
    this.apiUrl = process.env.SUMMER_AUTUMN_API_URL || auth.apiUrl || DEFAULT_AUTUMN_API_URL;
    this.auth = auth as SummerAuth;
    this.token = auth.accessToken;
    this.sdk = new Autumn({
      secretKey: auth.accessToken,
      serverURL: this.apiUrl
    });
  }

  /** Swap in a fresher auth (token + SDK). */
  private adopt(next: SummerAuth) {
    this.auth = next;
    this.token = next.accessToken;
    this.sdk = new Autumn({ secretKey: next.accessToken, serverURL: this.apiUrl });
  }

  /** Is `a` a different, not-about-to-expire access token we can use right now? */
  private isUsable(a: SummerAuth | null | undefined): a is SummerAuth {
    return Boolean(
      a?.accessToken &&
        a.accessToken !== this.token &&
        (!a.expiresAt || a.expiresAt > Date.now() + 30_000)
    );
  }

  /**
   * Get a fresh access token. Refresh tokens rotate and are single-use, so with multiple
   * processes (daemon + dash) our in-memory refresh token can already be spent. We therefore
   * (1) re-read auth.json first — another process may have just minted a token we can adopt;
   * (2) otherwise refresh using the freshest refresh token on disk; (3) if that loses the
   * rotation race, re-read once more and adopt the winner's token.
   */
  private async refreshToken(): Promise<boolean> {
    const stored = await readAuth();
    // Capture the freshest refresh token (and base auth) before any type narrowing.
    const refreshToken = stored?.refreshToken ?? this.auth.refreshToken;
    const base: SummerAuth = stored ?? this.auth;

    if (this.isUsable(stored)) {
      this.adopt(stored);
      log.debug({ action: "autumn_token_adopted" });
      return true;
    }
    if (!refreshToken) return false;

    try {
      const next = await refreshSharedAuth({ ...base, refreshToken });
      this.adopt(next);
      log.debug({ action: "autumn_token_refreshed" });
      return true;
    } catch (error) {
      const after = await readAuth();
      if (this.isUsable(after)) {
        this.adopt(after);
        log.debug({ action: "autumn_token_adopted_after_race" });
        return true;
      }
      log.warn({ action: "autumn_token_refresh_failed", error: (error as Error)?.message });
      return false;
    }
  }

  /**
   * Run an Autumn call; if it fails with an expired/invalid token, refresh once and retry.
   * The closure re-reads `this.sdk`/`this.token`, so the retry uses the refreshed credentials.
   */
  private async withRefresh<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isAuthError(error)) throw error;
      if (!(await this.refreshToken())) throw error;
      return await run();
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.withRefresh(async () => {
      const maxAttempts = 5;
      for (let attempt = 1; ; attempt += 1) {
        const response = await fetch(new URL(path, this.apiUrl), {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "X-API-Version": "2.1.0"
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        });

        const text = await response.text();

        if (response.ok) {
          if (!text) return null as T;
          // Tolerate a non-JSON success body rather than throwing a parse error.
          try {
            return JSON.parse(text) as T;
          } catch {
            return null as T;
          }
        }

        // Back off + retry on rate limits (429) and transient 5xx, honoring Retry-After.
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delayMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(500 * 2 ** (attempt - 1), 8000);
          log.debug({ action: "autumn_request_retry", path, status: response.status, attempt, delayMs });
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        const error = new Error(
          `Autumn ${method} ${path} failed (${response.status}): ${text.slice(0, 200)}`
        ) as Error & { statusCode?: number; status?: number; body?: string };
        error.statusCode = response.status;
        error.status = response.status;
        error.body = text;
        throw error;
      }
    });
  }

  organizationMe() {
    return this.request<{
      name: string;
      slug: string;
      env: string;
      id?: string;
      user?: SummerUser;
    }>("GET", "/v1/organization/me");
  }

  async getOrCreateCustomer(user: SummerUser) {
    return this.withRefresh(() =>
      this.sdk.customers.getOrCreate({
        customerId: user.id,
        name: user.name,
        email: user.email,
        metadata: {
          summer: true,
          autumnUserId: user.id
        }
      })
    );
  }

  async listFeatures() {
    return this.withRefresh(() => this.sdk.features.list()) as Promise<{ list: AutumnFeature[] }>;
  }

  async createFeature(feature: CreateFeatureParams) {
    return this.withRefresh(() => this.sdk.features.create(feature));
  }

  async updateFeature(featureId: string, feature: Omit<UpdateFeatureParams, "featureId">) {
    return this.withRefresh(() =>
      this.sdk.features.update({
        ...feature,
        featureId
      })
    );
  }

  async track(params: {
    customerId: string;
    featureId: string;
    value: number;
    properties?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    if (!Number.isFinite(params.value) || params.value === 0) return null;
    return this.withRefresh(() =>
      this.sdk.track(
        {
          customerId: params.customerId,
          featureId: params.featureId,
          value: params.value,
          properties: params.properties
        },
        params.idempotencyKey
          ? { headers: { "Idempotency-Key": params.idempotencyKey } }
          : undefined
      )
    );
  }

  async trackTokens(params: {
    customerId: string;
    featureId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    properties?: Record<string, unknown>;
    idempotencyKey?: string;
  }) {
    return this.withRefresh(() =>
      this.sdk.trackTokens(
        {
          customerId: params.customerId,
          featureId: params.featureId,
          modelId: params.modelId,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          cacheReadTokens: params.cacheReadTokens,
          cacheWriteTokens: params.cacheWriteTokens,
          reasoningTokens: params.reasoningTokens,
          properties: params.properties
        },
        params.idempotencyKey
          ? { headers: { "Idempotency-Key": params.idempotencyKey } }
          : undefined
      )
    );
  }

  /**
   * Like `trackTokens`, but records the event at a BACKDATED `timestamp` (epoch ms) — for historical
   * backfill. The autumn-js SDK doesn't expose `timestamp`/`idempotency_key`, so we call the raw
   * `POST /v1/balances.track_tokens` endpoint via `request()` (which carries the 401 auto-refresh).
   * Requires the Autumn server to forward `timestamp` on `trackTokens` (see backfill plan).
   * Returns the priced value (USD).
   */
  async trackTokensAt(params: TrackTokensAtParams): Promise<{ value?: number } | null> {
    return this.request<{ value?: number } | null>(
      "POST",
      "/v1/balances.track_tokens",
      trackTokensBody(params)
    );
  }

  /**
   * Batch up to 1000 backdated token events in one call to `/v1/balances.batch_track_tokens`.
   * Each item keeps its own `idempotencyKey`, so Autumn dedups per-event server-side and re-runs
   * are safe. Returns 202 with no per-item value (cost is priced asynchronously in Autumn).
   */
  async batchTrackTokensAt(items: TrackTokensAtParams[]): Promise<void> {
    if (items.length === 0) return;
    await this.request("POST", "/v1/balances.batch_track_tokens", items.map(trackTokensBody));
  }

  async check(params: { customerId: string; featureId: string }) {
    return this.withRefresh(() =>
      this.sdk.check({
        customerId: params.customerId,
        featureId: params.featureId
      })
    );
  }

  /** List raw usage events (requires the analytics:read scope). */
  async listEvents(params: {
    customerId?: string;
    featureId?: string;
    limit?: number;
    offset?: number;
  }) {
    return this.request<{
      list: Array<{
        id: string;
        timestamp: number;
        value?: number;
        customer_id?: string;
        feature_id?: string;
        properties?: Record<string, unknown>;
      }>;
      total?: number;
      has_more?: boolean;
    }>("POST", "/v1/events.list", {
      customer_id: params.customerId,
      feature_id: params.featureId,
      limit: params.limit ?? 100,
      offset: params.offset ?? 0
    });
  }

  /** List customers (developers). `search` matches id, name, or email. */
  async listCustomers(params: { limit?: number; offset?: number; search?: string } = {}) {
    return this.request<{
      list: Array<{
        id: string;
        name?: string | null;
        email?: string | null;
        created_at?: number;
        metadata?: Record<string, unknown> | null;
      }>;
      total?: number;
    }>("POST", "/v1/customers.list", {
      limit: params.limit ?? 100,
      offset: params.offset ?? 0,
      ...(params.search ? { search: params.search } : {})
    });
  }

  /** Update a customer's metadata (used by the metadata sync cron). */
  async updateCustomer(customerId: string, metadata: Record<string, unknown>) {
    return this.withRefresh(() => this.sdk.customers.update({ customerId, metadata }));
  }
}
