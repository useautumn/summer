import type { Provider, SummerPlan, UsageHarness } from "../domain/types.ts";

// Home dir for auth/state/snapshots. Overridable so a local `bun dl` dev instance can run fully
// isolated from a real `summer` install (separate auth, state, daemon) — see the `dl`/`dev` scripts.
export const SUMMER_DIR = process.env.SUMMER_DIR ?? ".summer";
// Production Autumn by default; `bun dl` overrides these via SUMMER_AUTUMN_API_URL/APP_URL for local.
export const DEFAULT_AUTUMN_API_URL = "https://api.useautumn.com";
export const DEFAULT_AUTUMN_APP_URL = "https://app.useautumn.com";
export const LOCALHOST = "127.0.0.1";
export const OTLP_PORT = 4318;
export const OTLP_LOGS_PATH = "/v1/logs";

export const getOtlpPort = () => {
  const raw = process.env.SUMMER_OTLP_PORT;
  if (!raw) return OTLP_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid SUMMER_OTLP_PORT: ${raw}`);
  }
  return parsed;
};

// --- Autumn feature catalog -------------------------------------------------

/** Money the org actually pays: seat cost (plan x seats) + API credit/balance top-ups. */
export const PREPAID_SPEND_FEATURE = "prepaid_spend";
/** AI credit system: dollar value of all token consumption, priced by Autumn via Models.dev. */
export const USAGE_FEATURE = "usage_in_usd";

export type SummerFeatureDef = {
  id: string;
  name: string;
  type: "metered" | "ai_credit_system" | "boolean";
  consumable?: boolean;
};

export const SUMMER_FEATURES: SummerFeatureDef[] = [
  { id: USAGE_FEATURE, name: "Usage in USD", type: "ai_credit_system" }
];

// --- Model id mapping (Autumn trackTokens expects '<provider>/<model>') -----

export const HARNESS_PROVIDER: Record<UsageHarness, Provider> = {
  claude_code: "anthropic",
  codex: "openai",
  // opencode is multi-provider; it supplies its own `providerID` per message, so this fallback
  // is only used if an opencode event somehow lacks a provider.
  opencode: "anthropic"
};

export const toModelId = (harness: UsageHarness, model: string) =>
  `${HARNESS_PROVIDER[harness]}/${model}`;

// --- Plan catalog (flat seat costs, declared by each developer) --------------

/** Map Claude's account `rate_limit_tier` (e.g. "default_claude_max_20x") to a known plan. */
export function planFromRateLimitTier(tier: string): SummerPlan | null {
  const t = tier.toLowerCase();
  if (t.includes("max_20x")) return PLAN_CATALOG.claude_max_20x;
  if (t.includes("max_5x")) return PLAN_CATALOG.claude_max_5x;
  if (t.includes("pro")) return PLAN_CATALOG.claude_pro;
  if (t.includes("team")) return PLAN_CATALOG.claude_team;
  return null;
}

export const PLAN_CATALOG: Record<string, SummerPlan> = {
  claude_pro: { id: "claude_pro", name: "Claude Pro", provider: "anthropic", monthlyUsd: 20 },
  claude_max_5x: { id: "claude_max_5x", name: "Claude Max 5x", provider: "anthropic", monthlyUsd: 100 },
  claude_max_20x: { id: "claude_max_20x", name: "Claude Max 20x", provider: "anthropic", monthlyUsd: 200 },
  claude_team: { id: "claude_team", name: "Claude Team (seat)", provider: "anthropic", monthlyUsd: 30 },
  chatgpt_plus: { id: "chatgpt_plus", name: "ChatGPT Plus", provider: "openai", monthlyUsd: 20 },
  chatgpt_pro: { id: "chatgpt_pro", name: "ChatGPT Pro", provider: "openai", monthlyUsd: 200 },
  chatgpt_business: { id: "chatgpt_business", name: "ChatGPT Business (seat)", provider: "openai", monthlyUsd: 30 }
};
