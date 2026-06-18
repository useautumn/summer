import { log } from "../logging/logger.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICES = ["Claude Code-credentials", "Claude Code"];

export type OauthLimit = {
  kind: string;
  group?: string;
  percent: number;
  severity: string;
  resets_at: string | null;
  is_active: boolean;
};

export type ClaudeUsageSnapshot = {
  at: string;
  fiveHourPct?: number;
  sevenDayPct?: number;
  limits: OauthLimit[];
  spend: {
    usedUsd: number;
    usedMinor: number;
    currency: string;
    exponent: number;
    enabled: boolean;
    percent?: number;
  };
};

function userAgent() {
  return `claude-code/${process.env.SUMMER_CLAUDE_VERSION ?? "2.1.181"}`;
}

/**
 * Read the Claude Code OAuth access token. On macOS it lives in the login Keychain
 * (no ~/.claude/.credentials.json); fall back to an env-provided token (`claude setup-token`).
 */
export async function readClaudeOauthToken(): Promise<string | null> {
  const envToken = process.env.SUMMER_CLAUDE_OAUTH_TOKEN ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken && envToken.trim().length > 0) return envToken.trim();

  for (const service of KEYCHAIN_SERVICES) {
    try {
      const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], {
        stdout: "pipe",
        stderr: "ignore"
      });
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      if (!out) continue;
      const json = JSON.parse(out) as {
        claudeAiOauth?: { accessToken?: string };
        accessToken?: string;
        access_token?: string;
      };
      const token = json.claudeAiOauth?.accessToken ?? json.accessToken ?? json.access_token;
      if (typeof token === "string" && token.length > 0) return token;
    } catch {
      // try the next service name
    }
  }
  return null;
}

/**
 * Fetch the Claude subscription usage snapshot (undocumented endpoint that Claude Code uses).
 * Returns null on missing token or any non-2xx (incl. the endpoint's aggressive 429s) — caller
 * must poll sparsely (>= 180s) with the claude-code User-Agent.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageSnapshot | null> {
  const token = await readClaudeOauthToken();
  if (!token) {
    log.debug({ action: "oauth_usage_no_token" });
    return null;
  }

  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": userAgent(),
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    log.warn({ action: "oauth_usage_fetch_error", error: String(error) });
    return null;
  }

  if (!res.ok) {
    log.warn({ action: "oauth_usage_http_error", status: res.status });
    return null;
  }

  const data = (await res.json()) as Record<string, unknown>;
  const fiveHour = data.five_hour as { utilization?: number } | undefined;
  const sevenDay = data.seven_day as { utilization?: number } | undefined;
  const spendObj = (data.spend ?? {}) as {
    used?: { amount_minor?: number; currency?: string; exponent?: number };
    enabled?: boolean;
    percent?: number;
  };
  const used = spendObj.used ?? {};
  const exponent = Number(used.exponent ?? 2);
  const usedMinor = Number(used.amount_minor ?? 0);

  return {
    at: new Date().toISOString(),
    fiveHourPct: fiveHour?.utilization,
    sevenDayPct: sevenDay?.utilization,
    limits: Array.isArray(data.limits) ? (data.limits as OauthLimit[]) : [],
    spend: {
      usedMinor,
      usedUsd: usedMinor / 10 ** exponent,
      currency: used.currency ?? "USD",
      exponent,
      enabled: Boolean(spendObj.enabled),
      percent: spendObj.percent
    }
  };
}

export type DetectedPlan = { rateLimitTier: string; capabilities: string[]; createdAt?: string };

/**
 * Detect the developer's Claude subscription plan from `/api/oauth/account` so the seat cost can be
 * set automatically (no manual `summer plan`). Picks the membership with a consumer subscription
 * capability (claude_max / claude_pro) and a `default_claude_*` rate_limit_tier.
 */
export async function fetchClaudeSubscription(): Promise<DetectedPlan | null> {
  const token = await readClaudeOauthToken();
  if (!token) return null;

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/api/oauth/account", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": userAgent(),
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    log.warn({ action: "oauth_account_fetch_error", error: String(error) });
    return null;
  }
  if (!res.ok) {
    log.warn({ action: "oauth_account_http_error", status: res.status });
    return null;
  }

  const data = (await res.json()) as {
    memberships?: Array<{
      organization?: { capabilities?: string[]; rate_limit_tier?: string; created_at?: string };
    }>;
  };
  for (const membership of data.memberships ?? []) {
    const org = membership.organization;
    const caps = org?.capabilities ?? [];
    const tier = org?.rate_limit_tier;
    if (
      (caps.includes("claude_max") || caps.includes("claude_pro")) &&
      typeof tier === "string" &&
      tier.startsWith("default_claude_")
    ) {
      return { rateLimitTier: tier, capabilities: caps, createdAt: org?.created_at };
    }
  }
  return null;
}
