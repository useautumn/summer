import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AutumnClient } from "../../clients/autumn.ts";
import { USAGE_FEATURE } from "../../config/constants.ts";
import { readState, writeState } from "../../config/storage.ts";
import type { BillingMode, SummerAuth, SummerTotals } from "../../domain/types.ts";
import { log, serializeError } from "../../logging/logger.ts";

const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
const SEEN_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export type AmpUsageRecord = {
  id: string;
  threadId: string;
  provider: string;
  model: string;
  createdMs: number;
  billingMode: BillingMode;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

type AmpThread = {
  id?: string;
  created?: number;
  messages?: Array<{
    role?: string;
    messageId?: string | number;
    usage?: {
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      timestamp?: string | number;
    };
  }>;
};

export function ampThreadDirs(): string[] {
  const explicit = process.env.AMP_DATA_DIR;
  if (explicit) return [...new Set(explicit.split(",").map((s) => s.trim()).filter(Boolean).map((s) => join(s, "threads")))];
  const dirs: string[] = [];
  if (process.env.XDG_DATA_HOME) dirs.push(join(process.env.XDG_DATA_HOME, "amp", "threads"));
  dirs.push(join(homedir(), ".local", "share", "amp", "threads"));
  return [...new Set(dirs)];
}

/** Convert Amp's model paths to Models.dev's provider/model identity. */
export function normalizeAmpModel(raw: string): { provider: string; model: string } | null {
  const accountPath = raw.match(/^accounts\/([^/]+)\/models\/(.+)$/);
  if (accountPath) return { provider: accountPath[1], model: accountPath[2] };
  const providerPath = raw.match(/^([^/]+)\/(.+)$/);
  if (providerPath) return { provider: providerPath[1], model: providerPath[2] };
  if (/^claude-/i.test(raw)) return { provider: "anthropic", model: raw };
  if (/^(gpt-|o\d|codex)/i.test(raw)) return { provider: "openai", model: raw };
  if (/^gemini-/i.test(raw)) return { provider: "google", model: raw };
  return null;
}

function ampBillingMode(): BillingMode {
  return process.env.SUMMER_AMP_BILLING_MODE === "api" ? "api" : "subscription";
}

export function parseAmpThread(text: string, fileName = "thread.json"): AmpUsageRecord[] {
  let thread: AmpThread;
  try {
    thread = JSON.parse(text) as AmpThread;
  } catch {
    return [];
  }
  const threadId = thread.id ?? basename(fileName, ".json");
  const out: AmpUsageRecord[] = [];
  for (const message of thread.messages ?? []) {
    const usage = message.usage;
    if (message.role !== "assistant" || message.messageId == null || !usage?.model) continue;
    const normalized = normalizeAmpModel(usage.model);
    if (!normalized) continue;
    const createdMs = typeof usage.timestamp === "number" ? usage.timestamp : Date.parse(String(usage.timestamp ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    const record = {
      id: `${threadId}:${message.messageId}`,
      threadId,
      ...normalized,
      createdMs,
      billingMode: ampBillingMode(),
      tokens: {
        input: Number(usage.inputTokens ?? 0),
        output: Number(usage.outputTokens ?? 0),
        cacheRead: Number(usage.cacheReadInputTokens ?? 0),
        cacheWrite: Number(usage.cacheCreationInputTokens ?? 0)
      }
    } satisfies AmpUsageRecord;
    if (Object.values(record.tokens).some((n) => n > 0)) out.push(record);
  }
  return out;
}

export async function collectAmpRecords(sinceMs = 0): Promise<AmpUsageRecord[]> {
  const out: AmpUsageRecord[] = [];
  for (const dir of ampThreadDirs()) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        if ((await stat(path)).mtimeMs < sinceMs) continue;
        out.push(...parseAmpThread(await readFile(path, "utf8"), name).filter((r) => r.createdMs >= sinceMs));
      } catch { /* skip files being replaced while Amp writes */ }
    }
  }
  return out;
}

const emptyTotals = (at: string): SummerTotals => ({ since: at, prepaidUsd: 0, usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 });
const unpriceable = (e: unknown) => {
  const error = e as { statusCode?: number; status?: number; body?: string; message?: string };
  return (error?.statusCode === 400 || error?.status === 400)
    && /not found in models\.dev/i.test(`${error?.body ?? ""} ${error?.message ?? ""}`);
};

export async function processAmpSessions(client: AutumnClient, auth: SummerAuth) {
  const customerId = auth.user?.id;
  if (!customerId) return;
  const records = await collectAmpRecords(Date.now() - RECENT_MS);
  if (!records.length) return;
  const state = await readState();
  const seen = { ...(state.ampSeen ?? {}) };
  let usageUsd = 0, usageRealUsd = 0, usageSubUsd = 0, inputTokens = 0, outputTokens = 0, changed = false;
  for (const r of records) {
    if (seen[r.id]) continue;
    try {
      const res = await client.trackTokensAt({
        customerId, featureId: USAGE_FEATURE, modelId: `${r.provider}/${r.model}`, timestamp: r.createdMs,
        inputTokens: r.tokens.input, outputTokens: r.tokens.output, cacheReadTokens: r.tokens.cacheRead,
        cacheWriteTokens: r.tokens.cacheWrite,
        properties: { harness: "amp", billing_mode: r.billingMode, model: r.model, provider: r.provider, session_id: r.threadId, source: "amp_session", user_email: auth.user?.email },
        idempotencyKey: `amp:${customerId}:${r.id}:usage`
      });
      const value = Number((res as { value?: number } | null)?.value) || 0;
      usageUsd += value;
      if (r.billingMode === "api") usageRealUsd += value; else usageSubUsd += value;
      inputTokens += r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite;
      outputTokens += r.tokens.output;
      seen[r.id] = r.createdMs;
      changed = true;
    } catch (error) {
      if (unpriceable(error)) { seen[r.id] = r.createdMs; changed = true; }
      else log.warn({ action: "amp_usage_track_failed", id: r.id, error: serializeError(error) });
    }
  }
  if (!changed) return;
  const cutoff = Date.now() - SEEN_RETAIN_MS;
  const pruned = Object.fromEntries(Object.entries(seen).filter(([, ms]) => ms >= cutoff));
  const fresh = await readState();
  const totals = fresh.totals ?? emptyTotals(new Date().toISOString());
  await writeState({ ...fresh, ampSeen: pruned, totals: { ...totals, usageUsd: totals.usageUsd + usageUsd, usageRealUsd: totals.usageRealUsd + usageRealUsd, usageSubUsd: totals.usageSubUsd + usageSubUsd, inputTokens: totals.inputTokens + inputTokens, outputTokens: totals.outputTokens + outputTokens } });
}

export async function gatherAmpRecords(opts: { since?: Date; until?: Date }) {
  const since = opts.since?.getTime(), until = opts.until?.getTime();
  return (await collectAmpRecords(0)).filter((r) => (since == null || r.createdMs >= since) && (until == null || r.createdMs < until));
}
