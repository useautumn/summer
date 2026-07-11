export type SummerAuth = {
  accessToken: string;
  tokenType: string;
  expiresAt?: number;
  refreshToken?: string;
  apiUrl: string;
  appUrl: string;
  org?: SummerOrg;
  user?: SummerUser;
};

export type SummerOrg = {
  id?: string;
  name: string;
  slug: string;
  env: string;
};

export type SummerUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type UsageHarness = "claude_code" | "codex" | "opencode" | "amp" | "pi";

/**
 * How a developer's AI usage is paid for, derived from telemetry:
 * - "subscription": authenticated via a Claude/ChatGPT account (Pro/Max/Team). The
 *   token cost is api-equivalent VALUE, not real spend.
 * - "api": authenticated via an API key. The token cost is REAL spend.
 *
 * included-vs-credits is intentionally NOT modelled — it is not observable per request.
 */
export type BillingMode = "subscription" | "api";

/**
 * Richer per-developer billing profile (drives how the seat is sourced, not usage routing):
 * - personal_sub: individually-bought Pro/Max (dev self-reports the plan)
 * - team_seat: org-managed seat (admin pulls /v1/organizations/users) [P2]
 * - api_key: usage-based API key (no seat)
 */
export type BillingProfile = "personal_sub" | "team_seat" | "api_key";

export type Provider = "anthropic" | "openai";

export type SummerPlan = {
  id: string; // e.g. "claude_max_20x"
  name: string;
  provider: Provider;
  monthlyUsd: number;
};

export type SummerState = {
  daemon?: {
    pid: number;
    port?: number;
    startedAt: string;
  };
  claude?: {
    patched: boolean;
    snapshotPath?: string;
    patchedAt?: string;
  };
  codex?: {
    patched: boolean;
    snapshotPath?: string;
    patchedAt?: string;
  };
  /** The developer's declared subscription plan (flat seat cost). */
  plan?: SummerPlan;
  /** Cached billing profile for this install. */
  billingProfile?: BillingProfile;
  /** ISO timestamp of the last time the flat seat cost was pushed to Autumn. */
  seatCostPushedAt?: string;
  /** YYYY-MM of the last seat-cost push (one flat charge per cycle). */
  seatCostPeriod?: string;
  /** Cumulative usage totals for this install (drives `summer report`). */
  totals?: SummerTotals;
  /** Last extra-usage (overage credit) spend seen, for delta dedup into prepaid_spend. */
  lastExtraSpend?: { period: string; usd: number };
  /** Latest /api/oauth/usage snapshot (plan utilization + extra-usage spend). */
  oauthUsage?: SummerOauthUsage;
  /** Per-Codex-session-file cumulative token totals, for delta dedup. */
  codexSessions?: Record<
    string,
    { mtime: number; input: number; cachedInput: number; output: number; reasoning: number }
  >;
  /** Latest Codex plan utilization (from session rate_limits), for metadata sync. */
  codexUsage?: { at: string; fiveHourPct?: number; sevenDayPct?: number; planType?: string | null };
  /** opencode assistant-message ids already tracked (id → createdMs), pruned to the recent window. */
  opencodeSeen?: Record<string, number>;
  /** Amp assistant-message ids already tracked (threadId:messageId → createdMs). */
  ampSeen?: Record<string, number>;
  /** Pi assistant-message ids already tracked (sessionId:messageId → createdMs). */
  piSeen?: Record<string, number>;
  /** The Autumn org the user confirmed to set Summer up in — gates the `start`/`setup` org prompt. */
  setup?: { orgId: string; confirmedAt: string };
  /** The installed on-boot autostart service (launchd on macOS, systemd --user on Linux). */
  service?: { kind: "launchd" | "systemd"; port: number; installedAt: string };
  /** Epoch ms when live tracking first recorded an event. Informational only — backfill fills gaps
   * per (harness, model, bucket) from Autumn's events.list, it does not cap on this. */
  liveTrackingSince?: number;
  /** ISO timestamp of the first time `start` offered an interactive backfill. Once set, `start`
   * stops auto-prompting — the user can still import anytime via `summer backfill`. */
  backfillPromptedAt?: string;
  /** Informational summary of the last `summer backfill` run (dedup state lives in Autumn). */
  backfill?: {
    lastRunAt: string;
    since?: string;
    until?: string;
    granularity: "daily" | "hourly";
    eventsSent: number;
    usd: number;
  };
  lastEvent?: {
    at: string;
    requestId?: string;
    model?: string;
    estimatedValueUsd?: number;
  };
  lastEvents?: Partial<Record<UsageHarness, SummerLastEvent>>;
};

export type SummerUsageEvent = {
  harness: UsageHarness;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  /** subscription | api — drives whether usage is real spend or api-equivalent value. */
  billingMode: BillingMode;
  /** Harness-emitted estimated cost. Sanity property only — NOT canonical (Autumn/Models.dev is). */
  estimatedCostUsd?: number;
  requestId?: string;
  sessionId?: string;
  source?: string;
  /** Usage time (epoch ms) from the harness event, so live events land on the day they happened
   * (not ingestion time) — keeps live + backfill day-bucketing consistent. */
  timestampMs?: number;
  raw: Record<string, unknown>;
};

export type SummerTotals = {
  since: string;
  /** Money paid in: seat cost + API credit/balance top-ups (USD). */
  prepaidUsd: number;
  /** Dollar value of all token consumption (USD), as computed by Autumn/Models.dev. */
  usageUsd: number;
  /** Portion of usageUsd from api-key usage (real spend). */
  usageRealUsd: number;
  /** Portion of usageUsd from subscription usage (api-equivalent value). */
  usageSubUsd: number;
  inputTokens: number;
  outputTokens: number;
};

export type SummerOauthUsage = {
  at: string;
  fiveHourPct?: number;
  sevenDayPct?: number;
  spendUsedUsd: number;
  spendEnabled: boolean;
  limits: { kind: string; percent: number; severity: string; resets_at: string | null; is_active: boolean }[];
};

export type SummerLastEvent = {
  at: string;
  harness: UsageHarness;
  requestId?: string;
  sessionId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
};
