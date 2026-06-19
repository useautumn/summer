import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { AutumnClient } from "../../clients/autumn.ts";
import { USAGE_FEATURE } from "../../config/constants.ts";
import { readState, writeState } from "../../config/storage.ts";
import type { SummerAuth, SummerTotals } from "../../domain/types.ts";
import { log, serializeError } from "../../logging/logger.ts";

// opencode is multi-provider and BYO-API-key → all usage is real pay-per-token spend.
const BILLING_MODE = "api" as const;
// Only scan recently-touched message files in the LIVE poller, to bound work.
const RECENT_MS = 2 * 24 * 60 * 60 * 1000;
// Keep processed ids longer than the scan window so we don't reprocess within it.
const SEEN_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export type OpencodeMessage = {
  id: string;
  sessionID?: string;
  providerID: string;
  modelID: string;
  createdMs: number;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
};

/** opencode data dirs to probe. Honors `OPENCODE_DATA_DIR` (comma-separated), then XDG + macOS. */
function opencodeBaseDirs(): string[] {
  // An explicit OPENCODE_DATA_DIR is authoritative (matches ccusage); else probe XDG + macOS.
  const env = process.env.OPENCODE_DATA_DIR;
  if (env) return [...new Set(env.split(",").map((s) => s.trim()).filter(Boolean))];
  const bases: string[] = [];
  if (process.env.XDG_DATA_HOME) bases.push(join(process.env.XDG_DATA_HOME, "opencode"));
  bases.push(join(homedir(), ".local", "share", "opencode"));
  bases.push(join(homedir(), "Library", "Application Support", "opencode"));
  return [...new Set(bases)];
}

/** Was a track call rejected because the model isn't in Models.dev pricing data (Autumn 400)? */
function isUnpriceableModel(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; body?: string; message?: string };
  const text = `${err?.body ?? ""} ${err?.message ?? ""}`;
  return (err?.statusCode === 400 || err?.status === 400) && /not found in models\.dev/i.test(text);
}

/** Map an opencode model id to a Models.dev-priceable id. opencode appends a `-fast` (priority/fast
 * service tier) suffix that isn't a distinct Models.dev model; Summer prices at the standard tier
 * anyway, so we strip it. Unknown models (e.g. OpenCode Zen) stay as-is and skip gracefully. */
export function normalizeOpencodeModel(model: string): string {
  return model.replace(/-fast$/, "");
}

type MessageData = {
  id?: string;
  sessionID?: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
};

/** Build an OpencodeMessage from a parsed `data` object, filling id/sessionID/created from the row
 * (current opencode stores those as SQLite columns, not inside `data`). Returns null if not a
 * usable assistant message. */
function toMessage(
  data: MessageData,
  ctx: { id?: string; sessionID?: string; createdMs?: number }
): OpencodeMessage | null {
  if (!data || data.role !== "assistant") return null;
  const id = data.id ?? ctx.id;
  const { modelID, providerID } = data;
  if (!id || !modelID || !providerID) return null;
  const created = Number(data.time?.created ?? ctx.createdMs);
  if (!Number.isFinite(created)) return null;
  const t = data.tokens ?? {};
  return {
    id,
    sessionID: data.sessionID ?? ctx.sessionID,
    providerID,
    modelID: normalizeOpencodeModel(modelID),
    createdMs: created,
    tokens: {
      input: Number(t.input ?? 0),
      output: Number(t.output ?? 0),
      reasoning: Number(t.reasoning ?? 0),
      cacheRead: Number(t.cache?.read ?? 0),
      cacheWrite: Number(t.cache?.write ?? 0)
    }
  };
}

/** Parse a standalone opencode message JSON (legacy file-based storage). */
export function parseMessageFile(text: string): OpencodeMessage | null {
  try {
    return toMessage(JSON.parse(text) as MessageData, {});
  } catch {
    return null;
  }
}

/** Read assistant messages from an opencode SQLite db (current storage), created at/after `sinceMs`. */
function readDbMessages(dbPath: string, sinceMs: number): OpencodeMessage[] {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    log.debug({ action: "opencode_db_open_failed", dbPath, error: serializeError(error) });
    return [];
  }
  const out: OpencodeMessage[] = [];
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const rows = db
      .query("SELECT id, session_id, time_created, data FROM message WHERE time_created >= ?")
      .all(sinceMs) as Array<{ id: string; session_id: string; time_created: number; data: string }>;
    for (const r of rows) {
      let data: MessageData;
      try {
        data = JSON.parse(r.data);
      } catch {
        continue;
      }
      const m = toMessage(data, { id: r.id, sessionID: r.session_id, createdMs: r.time_created });
      if (m) out.push(m);
    }
  } catch (error) {
    log.debug({ action: "opencode_db_query_failed", dbPath, error: serializeError(error) });
  } finally {
    db.close();
  }
  return out;
}

/** Read assistant messages from legacy JSON file storage (storage/message/<session>/*.json). */
async function readJsonMessages(messageDir: string, sinceMs: number): Promise<OpencodeMessage[]> {
  const out: OpencodeMessage[] = [];
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
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          if ((await stat(p)).mtimeMs < sinceMs) continue;
          const m = parseMessageFile(await readFile(p, "utf8"));
          if (m) out.push(m);
        } catch {
          // skip unreadable
        }
      }
    }
  }
  await walk(messageDir);
  return out;
}

/** Collect opencode assistant messages created at/after `sinceMs` across all data dirs. Prefers the
 * SQLite db (current opencode); falls back to legacy JSON files for older installs. */
export async function collectOpencodeMessages(sinceMs = 0): Promise<OpencodeMessage[]> {
  const out: OpencodeMessage[] = [];
  for (const base of opencodeBaseDirs()) {
    const dbPath = join(base, "opencode.db");
    if (existsSync(dbPath)) out.push(...readDbMessages(dbPath, sinceMs));
    else out.push(...(await readJsonMessages(join(base, "storage", "message"), sinceMs)));
  }
  return out;
}

const tokenTotal = (t: OpencodeMessage["tokens"]) =>
  t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;

function emptyTotals(at: string): SummerTotals {
  return { since: at, prepaidUsd: 0, usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 };
}

/**
 * Read opencode session message files and track per-message token usage into `usage_in_usd`.
 * Each assistant message is its own file with PER-MESSAGE token counts, so (unlike Codex) we don't
 * diff cumulatives — we track each message once, keyed by its id. Dedup is belt-and-suspenders:
 * a local `opencodeSeen` id-set skips re-reads, and the Autumn idempotency key makes restarts safe.
 */
export async function processOpencodeSessions(client: AutumnClient, auth: SummerAuth) {
  const customerId = auth.user?.id;
  if (!customerId) return;

  const messages = await collectOpencodeMessages(Date.now() - RECENT_MS);
  if (messages.length === 0) return;

  const state = await readState();
  const seen = { ...(state.opencodeSeen ?? {}) };
  const pollDelta = { usageUsd: 0, usageRealUsd: 0, inputTokens: 0, outputTokens: 0 };
  let changed = false;

  for (const msg of messages) {
    if (seen[msg.id] || tokenTotal(msg.tokens) <= 0) continue;

    const t = msg.tokens;
    try {
      // Stamp at the message's creation time (usage time), not poll time, so the event lands on the
      // day it happened — keeps opencode live day-bucketing consistent with backfill.
      const res = await client.trackTokensAt({
        customerId,
        featureId: USAGE_FEATURE,
        modelId: `${msg.providerID}/${msg.modelID}`,
        timestamp: msg.createdMs,
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadTokens: t.cacheRead,
        cacheWriteTokens: t.cacheWrite,
        reasoningTokens: t.reasoning,
        properties: {
          harness: "opencode",
          billing_mode: BILLING_MODE,
          model: msg.modelID,
          provider: msg.providerID,
          session_id: msg.sessionID,
          source: "opencode_session",
          user_email: auth.user?.email
        },
        idempotencyKey: `opencode:${customerId}:${msg.id}:usage`
      });
      const value = Number((res as { value?: number } | null)?.value) || 0;
      pollDelta.usageUsd += value;
      pollDelta.usageRealUsd += value; // opencode == api
      pollDelta.inputTokens += t.input + t.cacheRead;
      pollDelta.outputTokens += t.output + t.reasoning;
      seen[msg.id] = msg.createdMs;
      changed = true;
      log.debug({
        action: "opencode_usage_tracked",
        id: msg.id,
        provider: msg.providerID,
        model: msg.modelID,
        valueUsd: value
      });
    } catch (error) {
      if (isUnpriceableModel(error)) {
        // Models.dev can't price this model (e.g. OpenCode Zen) — mark seen so we don't retry it
        // every poll. Token utilization is lost; $ would be 0 anyway.
        seen[msg.id] = msg.createdMs;
        changed = true;
        log.debug({ action: "opencode_skip_unpriceable", id: msg.id, model: `${msg.providerID}/${msg.modelID}` });
      } else {
        log.warn({ action: "opencode_usage_track_failed", error: serializeError(error), id: msg.id });
      }
    }
  }

  if (!changed) return;

  // Prune the seen-set to the retention window so it can't grow unbounded.
  const prunedCutoff = Date.now() - SEEN_RETAIN_MS;
  const pruned: Record<string, number> = {};
  for (const [id, ms] of Object.entries(seen)) if (ms >= prunedCutoff) pruned[id] = ms;

  const fresh = await readState();
  const prevTotals = fresh.totals ?? emptyTotals(new Date().toISOString());
  await writeState({
    ...fresh,
    opencodeSeen: pruned,
    totals: {
      ...prevTotals,
      usageUsd: prevTotals.usageUsd + pollDelta.usageUsd,
      usageRealUsd: prevTotals.usageRealUsd + pollDelta.usageRealUsd,
      inputTokens: prevTotals.inputTokens + pollDelta.inputTokens,
      outputTokens: prevTotals.outputTokens + pollDelta.outputTokens
    }
  });
}

/** All opencode assistant messages in [since, until) — for backfill (one record per message). */
export async function gatherOpencodeRecords(opts: { since?: Date; until?: Date }): Promise<OpencodeMessage[]> {
  const sinceMs = opts.since?.getTime();
  const untilMs = opts.until?.getTime();
  const out: OpencodeMessage[] = [];
  for (const msg of await collectOpencodeMessages(0)) {
    if (tokenTotal(msg.tokens) <= 0) continue;
    if (sinceMs != null && msg.createdMs < sinceMs) continue;
    if (untilMs != null && msg.createdMs >= untilMs) continue;
    out.push(msg);
  }
  return out;
}
