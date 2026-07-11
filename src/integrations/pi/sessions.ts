import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutumnClient } from "../../clients/autumn.ts";
import { USAGE_FEATURE } from "../../config/constants.ts";
import { readState, writeState } from "../../config/storage.ts";
import type { BillingMode, SummerAuth, SummerTotals } from "../../domain/types.ts";
import { log, serializeError } from "../../logging/logger.ts";

const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
const SEEN_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export type PiUsageRecord = {
  id: string; sessionId: string; provider: string; model: string; createdMs: number; billingMode: BillingMode;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export function normalizePiProvider(provider: string): string {
  if (provider === "openai-codex" || provider === "github-copilot") return "openai";
  if (provider.startsWith("google-")) return "google";
  return provider;
}

export function normalizePiModel(provider: string, model: string): string {
  const hosted = model.match(new RegExp(`^accounts/${provider}/(?:models|routers)/(.+)$`));
  return hosted?.[1] ?? model;
}

function piBillingMode(provider: string): BillingMode {
  const override = process.env.SUMMER_PI_BILLING_MODE;
  if (override === "api" || override === "subscription") return override;
  return provider === "openai-codex" || provider === "github-copilot" ? "subscription" : "api";
}

export function parsePiSession(text: string): PiUsageRecord[] {
  let sessionId = "unknown";
  const out: PiUsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, any>;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === "session" && typeof row.id === "string") { sessionId = row.id; continue; }
    const message = row.message;
    if (row.type !== "message" || message?.role !== "assistant" || !row.id || !message.provider || !message.model) continue;
    const messageTimestamp = Number(message.timestamp);
    const createdMs = Number.isFinite(messageTimestamp) && messageTimestamp > 0
      ? messageTimestamp
      : Date.parse(String(row.timestamp ?? ""));
    if (!Number.isFinite(createdMs)) continue;
    const usage = message.usage ?? {};
    const record: PiUsageRecord = {
      id: `${sessionId}:${row.id}`, sessionId, provider: normalizePiProvider(message.provider),
      model: normalizePiModel(message.provider, message.model),
      createdMs, billingMode: piBillingMode(message.provider),
      tokens: { input: Number(usage.input ?? 0), output: Number(usage.output ?? 0), cacheRead: Number(usage.cacheRead ?? 0), cacheWrite: Number(usage.cacheWrite ?? 0) }
    };
    if (Object.values(record.tokens).some((n) => n > 0)) out.push(record);
  }
  return out;
}

function piSessionRoots(): string[] {
  const explicit = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (explicit) return explicit.split(",").map((s) => s.trim()).filter(Boolean);
  const config = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [join(config, "sessions")];
}

async function walkJsonl(dir: string, sinceMs: number, out: PiUsageRecord[]) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walkJsonl(path, sinceMs, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        if ((await stat(path)).mtimeMs < sinceMs) continue;
        out.push(...parsePiSession(await readFile(path, "utf8")));
      } catch { /* skip files being replaced while Pi writes */ }
    }
  }
}

export async function collectPiRecords(sinceMs = 0) {
  const out: PiUsageRecord[] = [];
  for (const root of piSessionRoots()) if (existsSync(root)) await walkJsonl(root, sinceMs, out);
  return out;
}

const emptyTotals = (at: string): SummerTotals => ({ since: at, prepaidUsd: 0, usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 });
const unpriceable = (e: unknown) => /not found in models\.dev/i.test(`${(e as { body?: string; message?: string })?.body ?? ""} ${(e as { message?: string })?.message ?? ""}`);

export async function processPiSessions(client: AutumnClient, auth: SummerAuth) {
  const customerId = auth.user?.id;
  if (!customerId) return;
  const records = await collectPiRecords(Date.now() - RECENT_MS);
  if (!records.length) return;
  const state = await readState();
  const seen = { ...(state.piSeen ?? {}) };
  let usageUsd = 0, usageRealUsd = 0, usageSubUsd = 0, inputTokens = 0, outputTokens = 0, changed = false;
  for (const r of records) {
    if (seen[r.id]) continue;
    try {
      const res = await client.trackTokensAt({ customerId, featureId: USAGE_FEATURE, modelId: `${r.provider}/${r.model}`, timestamp: r.createdMs,
        inputTokens: r.tokens.input, outputTokens: r.tokens.output, cacheReadTokens: r.tokens.cacheRead, cacheWriteTokens: r.tokens.cacheWrite,
        properties: { harness: "pi", billing_mode: r.billingMode, model: r.model, provider: r.provider, session_id: r.sessionId, source: "pi_session", user_email: auth.user?.email },
        idempotencyKey: `pi:${customerId}:${r.id}:usage` });
      const value = Number((res as { value?: number } | null)?.value) || 0;
      usageUsd += value;
      if (r.billingMode === "api") usageRealUsd += value; else usageSubUsd += value;
      inputTokens += r.tokens.input + r.tokens.cacheRead;
      outputTokens += r.tokens.output;
      seen[r.id] = r.createdMs;
      changed = true;
    } catch (error) {
      if (unpriceable(error)) { seen[r.id] = r.createdMs; changed = true; }
      else log.warn({ action: "pi_usage_track_failed", id: r.id, error: serializeError(error) });
    }
  }
  if (!changed) return;
  const cutoff = Date.now() - SEEN_RETAIN_MS;
  const pruned = Object.fromEntries(Object.entries(seen).filter(([, ms]) => ms >= cutoff));
  const fresh = await readState();
  const totals = fresh.totals ?? emptyTotals(new Date().toISOString());
  await writeState({ ...fresh, piSeen: pruned, totals: { ...totals, usageUsd: totals.usageUsd + usageUsd, usageRealUsd: totals.usageRealUsd + usageRealUsd, usageSubUsd: totals.usageSubUsd + usageSubUsd, inputTokens: totals.inputTokens + inputTokens, outputTokens: totals.outputTokens + outputTokens } });
}

export async function gatherPiRecords(opts: { since?: Date; until?: Date }) {
  const since = opts.since?.getTime(), until = opts.until?.getTime();
  return (await collectPiRecords(0)).filter((r) => (since == null || r.createdMs >= since) && (until == null || r.createdMs < until));
}
