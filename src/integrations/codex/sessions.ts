import { open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutumnClient } from "../../clients/autumn.ts";
import { USAGE_FEATURE } from "../../config/constants.ts";
import { readState, writeState } from "../../config/storage.ts";
import type { BillingMode, SummerAuth, SummerTotals } from "../../domain/types.ts";
import { log, serializeError } from "../../logging/logger.ts";

const CODEX_DIRS = [
  join(homedir(), ".codex", "sessions"),
  join(homedir(), ".codex", "archived_sessions")
];
// Only look at sessions touched recently, to bound work + avoid backfilling ancient history.
const RECENT_MS = 2 * 24 * 60 * 60 * 1000;

type Cumulative = { input: number; cachedInput: number; output: number; reasoning: number };
type Parsed = {
  sessionId?: string;
  model?: string;
  provider?: string;
  planType?: string | null;
  cumulative?: Cumulative;
  /** Timestamp of the latest token_count event — used to stamp the tracked delta at usage time. */
  cumulativeAt?: Date;
  rateLimits?: { fiveHourPct?: number; sevenDayPct?: number; planType?: string | null };
};

/** List Codex session JSONL files modified at/after `cutoffMs` (0 = all history, for backfill). */
export async function listCodexSessionFiles(cutoffMs = 0): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          if ((await stat(p)).mtimeMs >= cutoffMs) out.push(p);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  for (const dir of CODEX_DIRS) await walk(dir);
  return out;
}

// Only look at sessions touched recently for the LIVE poller, to bound work.
async function listRecentSessionFiles(): Promise<string[]> {
  return listCodexSessionFiles(Date.now() - RECENT_MS);
}

type RateLimits = { fiveHourPct?: number; sevenDayPct?: number; planType?: string | null };

/**
 * Read just the tail of the newest recent session file to extract the latest `rate_limits`
 * (5h/7d utilization + plan_type). Done on EVERY poll regardless of the token-tracking dedup,
 * so the dashboard's codex plan/utilization stays fresh even when no new tokens were tracked
 * (e.g. right after a daemon restart, when all files are already in the dedup state).
 */
async function readLatestRateLimits(files: string[]): Promise<RateLimits | null> {
  let newest: { file: string; mtime: number } | null = null;
  for (const file of files) {
    try {
      const mtime = (await stat(file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch {
      // skip unreadable
    }
  }
  if (!newest) return null;

  const TAIL_BYTES = 256 * 1024;
  let text: string;
  try {
    const fh = await open(newest.file, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const length = size - start;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      text = buf.toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }

  // Scan from the end for the last token_count event that carries rate_limits.
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("rate_limits")) continue;
    let obj: { type?: string; payload?: Record<string, unknown> };
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a truncated first line from the tail window
    }
    const p = obj.payload;
    if (obj.type !== "event_msg" || p?.type !== "token_count") continue;
    const rl = p.rate_limits as
      | { primary?: { used_percent?: number }; secondary?: { used_percent?: number }; plan_type?: string | null }
      | undefined;
    if (!rl) continue;
    return {
      fiveHourPct: rl.primary?.used_percent,
      sevenDayPct: rl.secondary?.used_percent,
      planType: rl.plan_type ?? null
    };
  }
  return null;
}

/** Parse a Codex rollout JSONL: latest model + provider, plan type, and cumulative token totals. */
function parseSession(text: string): Parsed {
  const parsed: Parsed = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta") {
      parsed.sessionId = (p.id as string) ?? parsed.sessionId;
      parsed.provider = (p.model_provider as string) ?? parsed.provider;
    } else if (obj.type === "turn_context") {
      if (p.model) parsed.model = p.model as string;
    } else if (obj.type === "event_msg" && p.type === "token_count") {
      const info = (p.info as { total_token_usage?: Record<string, number> } | undefined)?.total_token_usage;
      if (info) {
        parsed.cumulative = {
          input: Number(info.input_tokens ?? 0),
          cachedInput: Number(info.cached_input_tokens ?? 0),
          output: Number(info.output_tokens ?? 0),
          reasoning: Number(info.reasoning_output_tokens ?? 0)
        };
        const at = obj.timestamp ? new Date(obj.timestamp) : null;
        if (at && !Number.isNaN(at.getTime())) parsed.cumulativeAt = at;
      }
      const rl = p.rate_limits as {
        primary?: { used_percent?: number };
        secondary?: { used_percent?: number };
        plan_type?: string | null;
      } | undefined;
      if (rl) {
        parsed.planType = rl.plan_type ?? parsed.planType ?? null;
        parsed.rateLimits = {
          fiveHourPct: rl.primary?.used_percent,
          sevenDayPct: rl.secondary?.used_percent,
          planType: rl.plan_type ?? null
        };
      }
    }
  }
  return parsed;
}

export type CodexTimelineEvent = {
  at: Date;
  model: string;
  billingMode: BillingMode;
  cumulative: Cumulative;
};

/**
 * Parse a Codex rollout JSONL into a TIME-ORDERED list of token_count events (for backfill).
 * Unlike `parseSession` (which keeps only the latest cumulative), this preserves every
 * `token_count` event with its per-line `timestamp`, so the backfiller can diff consecutive
 * cumulatives and attribute each delta to the day/hour it occurred. Each event carries the model
 * in effect at that point (from the most recent `turn_context`).
 *
 * Billing mode is decided at the SESSION level, not per event: Codex sometimes omits `plan_type`
 * on individual `token_count` lines (rate_limits not yet repopulated), so a single subscription
 * session would otherwise split into a phantom "api" sliver. If ANY event in the session shows a
 * plan_type, the whole session is subscription; only a session with no plan_type at all is `api`.
 */
export function parseSessionTimeline(text: string): {
  provider: string;
  sessionId?: string;
  events: CodexTimelineEvent[];
} {
  let provider = "openai";
  let sessionId: string | undefined;
  let currentModel: string | undefined;
  let sessionPlanType: string | null = null;
  const partial: Array<Omit<CodexTimelineEvent, "billingMode">> = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const p = obj.payload;
    if (!p) continue;
    if (obj.type === "session_meta") {
      sessionId = (p.id as string) ?? sessionId;
      provider = (p.model_provider as string) ?? provider;
    } else if (obj.type === "turn_context") {
      if (p.model) currentModel = p.model as string;
    } else if (obj.type === "event_msg" && p.type === "token_count") {
      const info = (p.info as { total_token_usage?: Record<string, number> } | undefined)?.total_token_usage;
      if (!info || !currentModel) continue;
      const at = obj.timestamp ? new Date(obj.timestamp) : null;
      if (!at || Number.isNaN(at.getTime())) continue;
      const planType = (p.rate_limits as { plan_type?: string | null } | undefined)?.plan_type ?? null;
      if (planType) sessionPlanType = planType;
      partial.push({
        at,
        model: currentModel,
        cumulative: {
          input: Number(info.input_tokens ?? 0),
          cachedInput: Number(info.cached_input_tokens ?? 0),
          output: Number(info.output_tokens ?? 0),
          reasoning: Number(info.reasoning_output_tokens ?? 0)
        }
      });
    }
  }

  // Session-level billing mode: subscription if the session ever reported a plan_type, else api.
  const billingMode: BillingMode = sessionPlanType ? "subscription" : "api";
  const events: CodexTimelineEvent[] = partial.map((e) => ({ ...e, billingMode }));
  return { provider, sessionId, events };
}

function emptyTotals(at: string): SummerTotals {
  return { since: at, prepaidUsd: 0, usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 };
}

/**
 * Read Codex session JSONL files and track per-turn token usage into `usage_in_usd`.
 * Codex OTel is unreliable (interactive-only), so we read the session logs (the ccusage approach).
 * `total_token_usage` is cumulative per session, so we push the DELTA vs the last seen total
 * (tracked per session file in state) — idempotent across polls/restarts, never double-counted.
 */
export async function processCodexSessions(client: AutumnClient, auth: SummerAuth) {
  const customerId = auth.user?.id;
  if (!customerId) return;

  const files = await listRecentSessionFiles();
  if (files.length === 0) return;

  const state = await readState();
  const tracked = { ...(state.codexSessions ?? {}) };
  const pollDelta = { usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 };
  let changed = false;
  let newestRl: { mtime: number; rl: NonNullable<Parsed["rateLimits"]> } | null = null;

  for (const file of files) {
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    const prev = tracked[file];
    if (prev && prev.mtime === mtime) continue; // unchanged since last poll

    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSession(text);
    if (parsed.rateLimits && (!newestRl || mtime > newestRl.mtime)) {
      newestRl = { mtime, rl: parsed.rateLimits };
    }
    if (!parsed.cumulative || !parsed.model) {
      tracked[file] = {
        mtime,
        input: prev?.input ?? 0,
        cachedInput: prev?.cachedInput ?? 0,
        output: prev?.output ?? 0,
        reasoning: prev?.reasoning ?? 0
      };
      changed = true;
      continue;
    }

    const cur = parsed.cumulative;
    const base = prev ?? { mtime: 0, input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    const dCached = Math.max(0, cur.cachedInput - base.cachedInput);
    const dInputTotal = Math.max(0, cur.input - base.input); // codex input_tokens INCLUDES cached
    const nonCachedInput = Math.max(0, dInputTotal - dCached);
    const dOutput = Math.max(0, cur.output - base.output);
    const dReasoning = Math.max(0, cur.reasoning - base.reasoning);

    if (nonCachedInput + dCached + dOutput + dReasoning > 0) {
      const provider = parsed.provider || "openai";
      const billingMode: BillingMode = parsed.planType ? "subscription" : "api";
      try {
        // Stamp at the latest token_count time so the delta lands on the day it happened (not poll
        // time) — keeps Codex live day-bucketing consistent with backfill across midnight/poll lag.
        const res = await client.trackTokensAt({
          customerId,
          featureId: USAGE_FEATURE,
          modelId: `${provider}/${parsed.model}`,
          timestamp: parsed.cumulativeAt ? parsed.cumulativeAt.getTime() : Date.now(),
          inputTokens: nonCachedInput,
          outputTokens: dOutput,
          cacheReadTokens: dCached,
          reasoningTokens: dReasoning,
          properties: {
            harness: "codex",
            billing_mode: billingMode,
            model: parsed.model,
            session_id: parsed.sessionId,
            source: "codex_session",
            user_email: auth.user?.email
          },
          idempotencyKey: `codex:${customerId}:${parsed.sessionId}:${cur.input}:${cur.output}:${cur.reasoning}`
        });
        const value = Number((res as { value?: number } | null)?.value) || 0;
        pollDelta.usageUsd += value;
        if (billingMode === "api") pollDelta.usageRealUsd += value;
        else pollDelta.usageSubUsd += value;
        pollDelta.inputTokens += nonCachedInput + dCached;
        pollDelta.outputTokens += dOutput + dReasoning;
        log.debug({
          action: "codex_usage_tracked",
          session: parsed.sessionId,
          model: parsed.model,
          billingMode,
          inputTokens: nonCachedInput,
          cacheReadTokens: dCached,
          outputTokens: dOutput,
          reasoningTokens: dReasoning,
          valueUsd: value
        });
      } catch (error) {
        log.warn({ action: "codex_usage_track_failed", error: serializeError(error), session: parsed.sessionId });
        continue; // leave state for this file untouched so we retry next poll
      }
    }

    tracked[file] = {
      mtime,
      input: cur.input,
      cachedInput: cur.cachedInput,
      output: cur.output,
      reasoning: cur.reasoning
    };
    changed = true;
  }

  // Always refresh plan utilization from the newest file's tail, even when no tokens were
  // tracked this poll (dedup skips re-parsing already-seen files, so newestRl can be null).
  const latestRl = newestRl?.rl ?? (await readLatestRateLimits(files));
  const codexUsage = latestRl
    ? {
        at: new Date().toISOString(),
        fiveHourPct: latestRl.fiveHourPct,
        sevenDayPct: latestRl.sevenDayPct,
        planType: latestRl.planType
      }
    : undefined;

  // Persist if token deltas changed OR we learned/updated the plan utilization.
  const existing = await readState();
  const usageChanged =
    codexUsage &&
    (existing.codexUsage?.fiveHourPct !== codexUsage.fiveHourPct ||
      existing.codexUsage?.sevenDayPct !== codexUsage.sevenDayPct ||
      existing.codexUsage?.planType !== codexUsage.planType);
  if (!changed && !usageChanged) return;

  const fresh = existing;
  const prevTotals = fresh.totals ?? emptyTotals(new Date().toISOString());
  const trackedTokensThisPoll = pollDelta.inputTokens + pollDelta.outputTokens > 0;
  await writeState({
    ...fresh,
    codexSessions: tracked,
    codexUsage: codexUsage ?? fresh.codexUsage,
    // Informational: when live tracking first recorded usage. (Backfill no longer caps on this —
    // it fills gaps per (harness, model, bucket) the daemon didn't cover. See runBackfill.)
    liveTrackingSince: fresh.liveTrackingSince ?? (trackedTokensThisPoll ? Date.now() : undefined),
    totals: {
      ...prevTotals,
      usageUsd: prevTotals.usageUsd + pollDelta.usageUsd,
      usageRealUsd: prevTotals.usageRealUsd + pollDelta.usageRealUsd,
      usageSubUsd: prevTotals.usageSubUsd + pollDelta.usageSubUsd,
      inputTokens: prevTotals.inputTokens + pollDelta.inputTokens,
      outputTokens: prevTotals.outputTokens + pollDelta.outputTokens
    }
  });
}
