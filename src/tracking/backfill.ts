import { readFile } from "node:fs/promises";
import type { AutumnClient } from "../clients/autumn.ts";
import { USAGE_FEATURE, toModelId } from "../config/constants.ts";
import { readState, writeState } from "../config/storage.ts";
import type { BillingMode, SummerAuth, UsageHarness } from "../domain/types.ts";
import { readClaudeUsageRecords } from "../integrations/claude/transcripts.ts";
import { listCodexSessionFiles, parseSessionTimeline } from "../integrations/codex/sessions.ts";
import { gatherDroidRecords } from "../integrations/droid/sessions.ts";
import { gatherOpencodeRecords } from "../integrations/opencode/sessions.ts";
import { gatherPiRecords } from "../integrations/pi/sessions.ts";
import { log, serializeError } from "../logging/logger.ts";

export type Granularity = "daily" | "hourly";
export type HarnessSelector = "claude" | "codex" | "opencode" | "droid" | "pi" | "all";

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

/** A normalised per-event usage record from any harness. `inputTokens` excludes cache. */
type UsageRecord = {
  at: Date;
  harness: UsageHarness;
  model: string;
  /** Explicit Models.dev provider for multi-provider harnesses; else derived from harness. */
  provider?: string;
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
  provider?: string;
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

/** Was a track call rejected because the model isn't in Models.dev pricing data (Autumn 400)? */
function isUnpriceableModel(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; body?: string; message?: string };
  const text = `${err?.body ?? ""} ${err?.message ?? ""}`;
  return (err?.statusCode === 400 || err?.status === 400) && /not found in models\.dev/i.test(text);
}

const wantClaude = (h: HarnessSelector) => h === "all" || h === "claude";
const wantCodex = (h: HarnessSelector) => h === "all" || h === "codex";
const wantOpencode = (h: HarnessSelector) => h === "all" || h === "opencode";
const wantDroid = (h: HarnessSelector) => h === "all" || h === "droid";
const wantPi = (h: HarnessSelector) => h === "all" || h === "pi";

/** Models.dev model id for a bucket. Multi-provider harnesses supply their provider explicitly. */
const modelIdOf = (b: { harness: UsageHarness; model: string; provider?: string }) =>
  b.provider ? `${b.provider}/${b.model}` : toModelId(b.harness, b.model);

// Preserve the idempotency identity emitted by older releases for single-provider harnesses.
// Multi-provider harnesses need the provider-qualified id to avoid cross-provider collisions.
export const idempotencyModelOf = (b: { model: string; provider?: string }) =>
  b.provider ? `${b.provider}/${b.model}` : b.model;

/** Floor an instant to the start of its UTC day/hour (matches how live events + the dash bucket). */
function floorBucket(at: Date, g: Granularity): number {
  if (g === "hourly") {
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours());
  }
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

// Identity of a backfill bucket. We stamp it onto each event's `properties.backfill_key` so re-run
// matching is exact and independent of how Autumn stores `properties.model` (it canonicalises known
// models to the priced id, but may leave unknown models raw — which would otherwise break dedup).
const bucketKey = (b: BackfillBucket) =>
  `${b.harness}:${modelIdOf(b)}:${b.billingMode}:${b.label}`;

/** Recover a stored backfill event's bucket identity: prefer the self-contained key we wrote, else
 * reconstruct from properties (Autumn canonicalises `model` to the priced id, matching `bucketKey`). */
const backfillEventKey = (p: Record<string, unknown>): string | undefined => {
  if (typeof p.backfill_key === "string") return p.backfill_key;
  const bucket = p.bucket as string | undefined;
  if (!bucket) return undefined;
  return `${p.harness}:${p.model}:${p.billing_mode}:${bucket}`;
};

/** Live-coverage key — a (harness, model, bucket) the live daemon already recorded. Per-model so a
 * day where the daemon saw one model doesn't suppress backfill of a different model that day. */
const liveBucketKeyFromEvent = (harness: string, model: string, timestampMs: number, g: Granularity) =>
  `${harness}:${model}:${floorBucket(new Date(timestampMs), g)}`;
const liveBucketKey = (b: BackfillBucket) =>
  `${b.harness}:${modelIdOf(b)}:${b.bucketMs}`;

/**
 * Single source of truth, in ONE paged pass over THIS org's events.list (no per-bucket lookups):
 *  (a) `backfillKeys` — bucket identities already imported by backfill, so re-runs skip them, and
 *  (b) `liveBucketKeys` — (harness, bucket) the live daemon already covered, so backfill fills only
 *      the GAPS the daemon missed (instead of hard-capping at the oldest live event, which dropped
 *      everything after a brief live session). Idempotency keys remain the final safety net.
 * Because it reads Autumn (not local state), it self-corrects across an org recreation: a fresh org
 * returns nothing → everything re-sends.
 */
async function scanExistingEvents(
  client: AutumnClient,
  customerId: string,
  granularity: Granularity
): Promise<{ backfillKeys: Set<string>; liveBucketKeys: Set<string> }> {
  const backfillKeys = new Set<string>();
  const liveBucketKeys = new Set<string>();
  const PAGE = 1000;
  const MAX = 500_000;
  let complete = false;
  try {
    for (let offset = 0; offset < MAX; offset += PAGE) {
      const ev = await client.listEvents({ customerId, featureId: USAGE_FEATURE, limit: PAGE, offset });
      const list = ev.list ?? [];
      for (const e of list) {
        const props = e.properties ?? {};
        if (props.source === "backfill") {
          const key = backfillEventKey(props);
          if (key) backfillKeys.add(key);
        } else if (typeof e.timestamp === "number" && typeof props.harness === "string" && typeof props.model === "string") {
          liveBucketKeys.add(liveBucketKeyFromEvent(props.harness, props.model, e.timestamp, granularity));
        }
      }
      if (list.length < PAGE) {
        complete = true;
        break;
      }
    }
  } catch (error) {
    log.debug({ action: "backfill_scan_events_failed", error: serializeError(error) });
    return { backfillKeys, liveBucketKeys };
  }
  // If we stopped at MAX while still getting full pages, coverage is incomplete — backfill could
  // then re-send (idempotency dedups backfill-vs-backfill) or double-count vs live beyond the window.
  if (!complete) {
    log.warn({ action: "backfill_scan_truncated", scannedEvents: MAX });
  }
  return { backfillKeys, liveBucketKeys };
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

async function gatherOpencode(opts: { since?: Date; until?: Date }): Promise<UsageRecord[]> {
  const messages = await gatherOpencodeRecords({ since: opts.since, until: opts.until });
  return messages.map((m) => ({
    at: new Date(m.createdMs),
    harness: "opencode" as const,
    model: m.modelID,
    provider: m.providerID,
    billingMode: "api" as const,
    inputTokens: m.tokens.input,
    outputTokens: m.tokens.output,
    cacheReadTokens: m.tokens.cacheRead,
    cacheWriteTokens: m.tokens.cacheWrite,
    reasoningTokens: m.tokens.reasoning
  }));
}

async function gatherDroid(opts: { since?: Date; until?: Date; force?: boolean }): Promise<UsageRecord[]> {
  // Droid dedup vs live tracking is SESSION-level at gather time (not bucket-level): sessions the
  // live poller already tracked are excluded here, because Droid has no timeline — a partially
  // live-tracked session can't be split into "already sent" and "missing" buckets. `--force`
  // includes them again (idempotency + the live-covered-bucket skip still guard re-sends).
  const tracked = opts.force ? undefined : new Set(Object.keys((await readState()).droidSessions ?? {}));
  const sessions = await gatherDroidRecords({ since: opts.since, until: opts.until, excludeFiles: tracked });
  return sessions.map((s) => ({
    at: s.at,
    harness: "droid" as const,
    model: s.model,
    provider: s.provider,
    billingMode: s.billingMode,
    inputTokens: s.tokens.input,
    outputTokens: s.tokens.output,
    cacheReadTokens: s.tokens.cacheRead,
    cacheWriteTokens: s.tokens.cacheWrite,
    reasoningTokens: s.tokens.reasoning
  }));
}

async function gatherPi(opts: { since?: Date; until?: Date }): Promise<UsageRecord[]> {
  return (await gatherPiRecords(opts)).map((r) => ({
    at: new Date(r.createdMs), harness: "pi", model: r.model, provider: r.provider,
    billingMode: r.billingMode, inputTokens: r.tokens.input, outputTokens: r.tokens.output,
    cacheReadTokens: r.tokens.cacheRead, cacheWriteTokens: r.tokens.cacheWrite, reasoningTokens: 0
  }));
}

function bucketize(records: UsageRecord[], g: Granularity): BackfillBucket[] {
  const map = new Map<string, BackfillBucket>();
  for (const r of records) {
    const bucketMs = floorBucket(r.at, g);
    const label = new Date(bucketMs).toISOString();
    const key = `${r.harness}|${r.provider ?? ""}|${r.model}|${r.billingMode}|${label}`;
    let b = map.get(key);
    if (!b) {
      b = {
        harness: r.harness,
        model: r.model,
        provider: r.provider,
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
// Autumn's /v1/balances.batch_track_tokens accepts up to 1000 events per call.
const BACKFILL_BATCH_SIZE = Math.min(1000, Math.max(1, Number(process.env.SUMMER_BACKFILL_BATCH_SIZE ?? 1000)));

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
 * Import historical Claude Code, Codex, OpenCode, Droid + Pi usage into Autumn as backdated, daily/hourly-aggregated
 * `usage_in_usd` events. State lives in Autumn, not locally: a single `events.list` scan tells us
 * which buckets we've already backfilled AND which (harness, model, bucket) the live daemon already
 * covers — so re-runs fill only the GAPS the daemon missed and never double-count live usage. This
 * self-corrects across an org recreation. Per-bucket idempotency keys are the final safety net.
 * Never touches `state.totals` (the live "since" lens).
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

  // One paged scan of THIS org's events = the source of truth (already-imported backfill buckets +
  // which (harness, bucket) the live daemon already covered). Cheap: a single events.list pass.
  const { backfillKeys, liveBucketKeys } = await scanExistingEvents(client, customerId, opts.granularity);

  // Upper bound: explicit --until, else now. We no longer hard-cap at the oldest live event — instead
  // we skip the specific buckets live already covered (below), so backfill fills the gaps it missed.
  const explicitUntilMs = opts.until?.getTime();
  const until = explicitUntilMs != null ? new Date(explicitUntilMs) : new Date();
  const since = opts.since;

  const records: UsageRecord[] = [];
  if (wantClaude(opts.harness)) {
    records.push(...(await gatherClaude({ since, until, billingMode: opts.billingMode })));
  }
  if (wantCodex(opts.harness)) {
    records.push(...(await gatherCodex({ since, until })));
  }
  if (wantOpencode(opts.harness)) {
    records.push(...(await gatherOpencode({ since, until })));
  }
  if (wantDroid(opts.harness)) {
    records.push(...(await gatherDroid({ since, until, force: opts.force })));
  }
  if (wantPi(opts.harness)) records.push(...(await gatherPi({ since, until })));

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

  // Skip buckets we've already backfilled (backfillKeys) AND buckets the live daemon already covered
  // (liveBucketKeys) — so re-runs fill only the gaps, never double-count live usage. `--force` ignores
  // both. Computed BEFORE the dry-run return so `--dry-run` reflects what would actually send.
  const toSend = opts.force
    ? buckets
    : buckets.filter((b) => !backfillKeys.has(bucketKey(b)) && !liveBucketKeys.has(liveBucketKey(b)));
  result.skipped = buckets.length - toSend.length;

  if (opts.dryRun) return result;

  // Build a track-tokens body per gap bucket. Each carries its own idempotency key, so Autumn dedups
  // per-event server-side and re-runs are safe. `async: true` → enqueued (202), priced later, so the
  // batch response has no per-event value (the $ shows up in Autumn shortly, not in this summary).
  const toBody = (b: BackfillBucket) => {
    // customerId MUST be in the key: Autumn scopes idempotency to org+env (NOT customer), so without
    // it two developers in the same org produce identical keys and collide — the second's events get
    // skipped as "duplicate", silently losing that developer's usage.
    const idempotencyBase = `backfill:${customerId}:${b.harness}:${idempotencyModelOf(b)}:${b.billingMode}:${opts.granularity}:${b.label}`;
    return {
      customerId,
      featureId: USAGE_FEATURE,
      modelId: modelIdOf(b),
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
        ...(b.provider ? { provider: b.provider } : {}),
        source: "backfill",
        bucket: b.label,
        // Self-contained dedup identity (survives Autumn's model canonicalisation; see backfillEventKey).
        backfill_key: bucketKey(b),
        user_email: auth.user?.email
      },
      idempotencyKey: opts.idempotencySalt ? `${idempotencyBase}:${opts.idempotencySalt}` : idempotencyBase,
      async: true
    };
  };

  // Ship buckets via batch_track_tokens (≤1000/call), a few batches in flight. Far fewer round-trips
  // than one call per bucket, and gentle on Autumn. A failed batch (after the client's 429/5xx
  // backoff) is collected for one retry sweep.
  const batches: BackfillBucket[][] = [];
  for (let i = 0; i < toSend.length; i += BACKFILL_BATCH_SIZE) {
    batches.push(toSend.slice(i, i + BACKFILL_BATCH_SIZE));
  }
  const failures: BackfillBucket[] = [];
  const sendBatch = async (batch: BackfillBucket[]) => {
    try {
      await client.batchTrackTokensAt(batch.map(toBody));
      result.sent += batch.length;
    } catch (error) {
      // batch_track_tokens is all-or-nothing and 400s the WHOLE batch if any model isn't in
      // Models.dev. Retry per bucket so one unpriceable model (e.g. OpenCode Zen) doesn't drop
      // every other bucket; tolerate per-bucket unpriceable-model 400s as skips.
      log.debug({ action: "backfill_batch_failed_splitting", error: serializeError(error), buckets: batch.length });
      for (const b of batch) {
        try {
          await client.batchTrackTokensAt([toBody(b)]);
          result.sent += 1;
        } catch (single) {
          if (isUnpriceableModel(single)) {
            result.skipped += 1;
            log.debug({ action: "backfill_skip_unpriceable", model: modelIdOf(b) });
          } else {
            failures.push(b);
          }
        }
      }
    }
  };
  await runPool(batches, sendBatch, BACKFILL_CONCURRENCY);

  // One retry sweep for batches that failed (idempotency makes re-sends safe).
  if (failures.length > 0) {
    log.info({ action: "backfill_retry_sweep", count: failures.length });
    const retrying = failures.splice(0);
    for (let i = 0; i < retrying.length; i += BACKFILL_BATCH_SIZE) {
      await sendBatch(retrying.slice(i, i + BACKFILL_BATCH_SIZE));
    }
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
