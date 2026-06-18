import { readFile } from "node:fs/promises";
import type { AutumnClient } from "../clients/autumn.ts";
import { USAGE_FEATURE, toModelId } from "../config/constants.ts";
import { readState, writeState } from "../config/storage.ts";
import type { BillingMode, SummerAuth, UsageHarness } from "../domain/types.ts";
import { readClaudeUsageRecords } from "../integrations/claude/transcripts.ts";
import { listCodexSessionFiles, parseSessionTimeline } from "../integrations/codex/sessions.ts";
import { log, serializeError } from "../logging/logger.ts";
import { isDuplicateIdempotency } from "./tracker.ts";

export type Granularity = "daily" | "hourly";
export type HarnessSelector = "claude" | "codex" | "all";

export type BackfillOptions = {
  since?: Date;
  until?: Date;
  granularity: Granularity;
  harness: HarnessSelector;
  /** Claude transcripts don't record billing mode; caller picks the default. */
  billingMode: BillingMode;
  dryRun: boolean;
  /** Ignore the local watermark and re-send every bucket (Autumn idempotency still dedups). */
  force?: boolean;
  idempotencySalt?: string;
};

/** A normalised per-event usage record from either harness. `inputTokens` excludes cache. */
type UsageRecord = {
  at: Date;
  harness: UsageHarness;
  model: string;
  billingMode: BillingMode;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type BackfillBucket = {
  harness: UsageHarness;
  model: string;
  billingMode: BillingMode;
  bucketMs: number;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type BackfillResult = {
  dryRun: boolean;
  since?: string;
  until: string;
  granularity: Granularity;
  buckets: BackfillBucket[];
  sent: number;
  skipped: number;
  failed: number;
  usd: number;
  byHarness: Record<string, { buckets: number; inputTokens: number; outputTokens: number; usd: number }>;
};

const wantClaude = (h: HarnessSelector) => h === "all" || h === "claude";
const wantCodex = (h: HarnessSelector) => h === "all" || h === "codex";

/** Floor an instant to the start of its UTC day/hour (matches how live events + the dash bucket). */
function floorBucket(at: Date, g: Granularity): number {
  if (g === "hourly") {
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours());
  }
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** Identity of a backfill event/bucket — must match between candidate buckets and stored events. */
const backfillEventKey = (p: Record<string, unknown>): string | undefined => {
  const bucket = p.bucket as string | undefined;
  if (!bucket) return undefined;
  return `${p.harness}:${p.model}:${p.billing_mode}:${bucket}`;
};
// Autumn canonicalises stored `properties.model` to the priced model_id (e.g. "openai/gpt-5.5"),
// so the candidate key must use the same form to match `backfillEventKey` on re-runs.
const bucketKey = (b: BackfillBucket) =>
  `${b.harness}:${toModelId(b.harness, b.model)}:${b.billingMode}:${b.label}`;

/**
 * Single source of truth: page through THIS org's events.list once and derive both
 *  (a) `earliestLiveMs` — the oldest non-backfill event, so backfill auto-caps there and never
 *      overlaps the live daemon, and
 *  (b) `backfillKeys` — bucket identities already imported, so re-runs skip them.
 * Because it reads Autumn (not local state), it self-corrects across an org recreation: a fresh org
 * returns nothing → everything re-sends. (Autumn idempotency is still the final safety net.)
 */
async function scanExistingEvents(
  client: AutumnClient,
  customerId: string
): Promise<{ earliestLiveMs?: number; backfillKeys: Set<string> }> {
  const backfillKeys = new Set<string>();
  let earliestLiveMs: number | undefined;
  const PAGE = 1000;
  const MAX = 50_000;
  try {
    for (let offset = 0; offset < MAX; offset += PAGE) {
      const ev = await client.listEvents({ customerId, featureId: USAGE_FEATURE, limit: PAGE, offset });
      const list = ev.list ?? [];
      for (const e of list) {
        const props = e.properties ?? {};
        if (props.source === "backfill") {
          const key = backfillEventKey(props);
          if (key) backfillKeys.add(key);
        } else if (typeof e.timestamp === "number") {
          if (earliestLiveMs === undefined || e.timestamp < earliestLiveMs) earliestLiveMs = e.timestamp;
        }
      }
      if (list.length < PAGE) break;
    }
  } catch (error) {
    log.debug({ action: "backfill_scan_events_failed", error: serializeError(error) });
  }
  return { earliestLiveMs, backfillKeys };
}

async function gatherClaude(opts: { since?: Date; until?: Date; billingMode: BillingMode }): Promise<UsageRecord[]> {
  const records = await readClaudeUsageRecords({ since: opts.since, until: opts.until });
  return records.map((r) => ({
    at: r.at,
    harness: "claude_code" as const,
    model: r.model,
    billingMode: opts.billingMode,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    reasoningTokens: 0
  }));
}

async function gatherCodex(opts: { since?: Date; until?: Date }): Promise<UsageRecord[]> {
  const sinceMs = opts.since?.getTime();
  const untilMs = opts.until?.getTime();
  const out: UsageRecord[] = [];
  const files = await listCodexSessionFiles(0); // all history

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const { events } = parseSessionTimeline(text);
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    // total_token_usage is cumulative per session — diff consecutive events for per-interval deltas.
    let base = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
    for (const ev of events) {
      const cur = ev.cumulative;
      const dCached = Math.max(0, cur.cachedInput - base.cachedInput);
      const dInputTotal = Math.max(0, cur.input - base.input); // codex input INCLUDES cached
      const nonCachedInput = Math.max(0, dInputTotal - dCached);
      const dOutput = Math.max(0, cur.output - base.output);
      const dReasoning = Math.max(0, cur.reasoning - base.reasoning);
      base = cur;

      const atMs = ev.at.getTime();
      if (sinceMs != null && atMs < sinceMs) continue;
      if (untilMs != null && atMs >= untilMs) continue;
      if (nonCachedInput + dCached + dOutput + dReasoning <= 0) continue;

      out.push({
        at: ev.at,
        harness: "codex",
        model: ev.model,
        billingMode: ev.billingMode,
        inputTokens: nonCachedInput,
        outputTokens: dOutput,
        cacheReadTokens: dCached,
        cacheWriteTokens: 0,
        reasoningTokens: dReasoning
      });
    }
  }
  return out;
}

function bucketize(records: UsageRecord[], g: Granularity): BackfillBucket[] {
  const map = new Map<string, BackfillBucket>();
  for (const r of records) {
    const bucketMs = floorBucket(r.at, g);
    const label = new Date(bucketMs).toISOString();
    const key = `${r.harness}|${r.model}|${r.billingMode}|${label}`;
    let b = map.get(key);
    if (!b) {
      b = {
        harness: r.harness,
        model: r.model,
        billingMode: r.billingMode,
        bucketMs,
        label,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0
      };
      map.set(key, b);
    }
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    b.cacheWriteTokens += r.cacheWriteTokens;
    b.reasoningTokens += r.reasoningTokens;
  }
  return [...map.values()].sort((a, b) => a.bucketMs - b.bucketMs);
}

/** Max in-flight track_tokens requests during backfill — bounds load on Autumn. */
const BACKFILL_CONCURRENCY = Math.max(1, Number(process.env.SUMMER_BACKFILL_CONCURRENCY ?? 2));

/** Run `worker` over `items` with at most `concurrency` promises in flight. */
async function runPool<T>(items: T[], worker: (item: T) => Promise<void>, concurrency: number): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  });
  await Promise.all(runners);
}

/**
 * Import historical Claude Code + Codex usage into Autumn as backdated, daily/hourly-aggregated
 * `usage_in_usd` events. State lives in Autumn, not locally: a single `events.list` scan gives both
 * the auto-cap (oldest live event → no overlap with the daemon) and which buckets are already
 * imported (→ fast re-runs). This self-corrects across an org recreation. Per-bucket idempotency
 * keys are the final safety net. Never touches `state.totals` (the live "since" lens).
 */
export async function runBackfill(
  client: AutumnClient,
  auth: SummerAuth,
  opts: BackfillOptions
): Promise<BackfillResult> {
  const customerId = auth.user?.id;
  if (!customerId) throw new Error("Summer auth is missing user.id");

  // Ensure the customer exists + is cached in Autumn BEFORE we enqueue any usage. Backfill events
  // are sent async; if the customer isn't there when the worker processes them, they fail server-side
  // and never become events — so the dedup scan never sees them and they re-send on every run.
  if (auth.user) {
    try {
      await client.getOrCreateCustomer(auth.user);
    } catch (error) {
      log.warn({ action: "backfill_ensure_customer_failed", error: serializeError(error) });
    }
  }

  // One scan of THIS org's events = the source of truth (auto-cap + already-imported buckets).
  const { earliestLiveMs, backfillKeys } = await scanExistingEvents(client, customerId);

  // Upper bound: min(explicit --until, oldest live event). No live events yet → nothing to overlap.
  const explicitUntilMs = opts.until?.getTime();
  const untilMs = Math.min(explicitUntilMs ?? Number.POSITIVE_INFINITY, earliestLiveMs ?? Number.POSITIVE_INFINITY);
  const until = Number.isFinite(untilMs) ? new Date(untilMs) : new Date();
  const since = opts.since;

  const records: UsageRecord[] = [];
  if (wantClaude(opts.harness)) {
    records.push(...(await gatherClaude({ since, until, billingMode: opts.billingMode })));
  }
  if (wantCodex(opts.harness)) {
    records.push(...(await gatherCodex({ since, until })));
  }

  const buckets = bucketize(records, opts.granularity);

  const result: BackfillResult = {
    dryRun: opts.dryRun,
    since: since?.toISOString(),
    until: until.toISOString(),
    granularity: opts.granularity,
    buckets,
    sent: 0,
    skipped: 0,
    failed: 0,
    usd: 0,
    byHarness: {}
  };
  const bump = (h: string, patch: Partial<{ buckets: number; inputTokens: number; outputTokens: number; usd: number }>) => {
    const cur = result.byHarness[h] ?? { buckets: 0, inputTokens: 0, outputTokens: 0, usd: 0 };
    result.byHarness[h] = {
      buckets: cur.buckets + (patch.buckets ?? 0),
      inputTokens: cur.inputTokens + (patch.inputTokens ?? 0),
      outputTokens: cur.outputTokens + (patch.outputTokens ?? 0),
      usd: cur.usd + (patch.usd ?? 0)
    };
  };

  // Tally every candidate bucket first (drives the summary + dry-run table).
  for (const b of buckets) {
    bump(b.harness, { buckets: 1, inputTokens: b.inputTokens, outputTokens: b.outputTokens });
  }
  if (opts.dryRun) return result;

  // Only send buckets not already imported in this org (unless --force).
  const toSend = opts.force ? buckets : buckets.filter((b) => !backfillKeys.has(bucketKey(b)));
  result.skipped = buckets.length - toSend.length;

  // Send each bucket with `async: true` so Autumn ENQUEUES it (202, no synchronous balance work),
  // and cap in-flight requests so a big import never floods Autumn. Async responses omit `value`,
  // so the priced $ shows up in Autumn shortly rather than in this summary.
  // Buckets that error (after the client's own 429/5xx backoff) are collected for one retry sweep.
  const failures: BackfillBucket[] = [];
  const sendBucket = async (b: BackfillBucket) => {
    const idempotencyBase = `backfill:${b.harness}:${b.model}:${b.billingMode}:${opts.granularity}:${b.label}`;
    const idempotencyKey = opts.idempotencySalt ? `${idempotencyBase}:${opts.idempotencySalt}` : idempotencyBase;
    try {
      const res = await client.trackTokensAt({
        customerId,
        featureId: USAGE_FEATURE,
        modelId: toModelId(b.harness, b.model),
        timestamp: b.bucketMs,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheReadTokens: b.cacheReadTokens,
        cacheWriteTokens: b.cacheWriteTokens,
        reasoningTokens: b.reasoningTokens,
        properties: {
          harness: b.harness,
          billing_mode: b.billingMode,
          model: b.model,
          source: "backfill",
          bucket: b.label,
          user_email: auth.user?.email
        },
        idempotencyKey,
        async: true
      });
      const value = Number(res?.value) || 0; // present only when Autumn processes synchronously
      result.sent += 1;
      result.usd += value;
      bump(b.harness, { usd: value });
      return true;
    } catch (error) {
      if (isDuplicateIdempotency(error)) {
        result.skipped += 1;
        return true;
      }
      log.warn({ action: "backfill_track_failed", error: serializeError(error), bucket: b.label, harness: b.harness });
      return false;
    }
  };
  await runPool(toSend, async (b) => {
    if (!(await sendBucket(b))) failures.push(b);
  }, BACKFILL_CONCURRENCY);

  // One retry sweep for buckets that failed to send (idempotency makes re-sends safe).
  if (failures.length > 0) {
    log.info({ action: "backfill_retry_sweep", count: failures.length });
    const retrying = failures.splice(0);
    await runPool(retrying, async (b) => {
      if (!(await sendBucket(b))) failures.push(b);
    }, 1);
  }
  result.failed = failures.length;

  {
    const fresh = await readState();
    await writeState({
      ...fresh,
      backfill: {
        lastRunAt: new Date().toISOString(),
        since: result.since,
        until: result.until,
        granularity: opts.granularity,
        eventsSent: result.sent,
        usd: result.usd
      }
    });
  }

  return result;
}
