import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AutumnClient } from "../../clients/autumn.ts";
import { USAGE_FEATURE } from "../../config/constants.ts";
import { readState, writeState } from "../../config/storage.ts";
import type { BillingMode, SummerAuth, SummerTotals } from "../../domain/types.ts";
import { log, serializeError } from "../../logging/logger.ts";
import { isDuplicateIdempotency } from "../../tracking/tracker.ts";

const RECENT_MS = 2 * 24 * 60 * 60 * 1000;

export type DroidTokens = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

const EMPTY_TOKENS: DroidTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
const tokenTotal = (tokens: DroidTokens) =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning;
const positiveNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export type DroidSession = {
  sessionId: string;
  model: string;
  provider: string;
  billingMode: BillingMode;
  at: Date;
  tokens: DroidTokens;
  mtime: number;
};

type DroidSettings = {
  model?: string;
  providerLock?: string;
  effectiveFactoryRouterModel?: { modelId?: string };
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    thinkingTokens?: number;
  };
};

function factoryRoots(): string[] {
  const configured = process.env.FACTORY_DATA_DIR ?? process.env.DROID_DATA_DIR;
  if (configured) return [...new Set(configured.split(",").map((s) => s.trim()).filter(Boolean))];
  return [join(homedir(), ".factory")];
}

/** Map Droid's model labels to the canonical Models.dev vendor namespace. */
export function droidModelProvider(model: string, providerLock?: string): string | null {
  const value = model.toLowerCase();
  if (value.startsWith("claude-")) return "anthropic";
  if (/^(gpt-|o[134]-|codex-)/.test(value)) return "openai";
  if (value.startsWith("gemini-")) return "google";
  if (value.startsWith("grok-")) return "xai";
  if (value.startsWith("kimi-")) return "moonshotai";
  if (value.startsWith("glm-")) return "zhipuai";
  if (value.startsWith("minimax-")) return "minimax";
  if (value.startsWith("deepseek-")) return "deepseek";
  const lock = providerLock?.toLowerCase();
  if (lock === "google-vertex") return "google";
  if (lock && ["anthropic", "openai", "google", "xai", "moonshotai", "zhipuai"].includes(lock)) return lock;
  return null;
}

function normalizedModel(settings: DroidSettings): string | null {
  const selected = settings.model === "auto" ? settings.effectiveFactoryRouterModel?.modelId : settings.model;
  if (!selected) return null;
  // Custom model ids are stored as `custom:<display-name>-<index>`.
  const model = selected.startsWith("custom:") ? selected.slice("custom:".length).replace(/-\d+$/, "") : selected;
  // Models.dev preserves MiniMax's branded casing in its canonical model ids.
  return model.replace(/^minimax-m/i, "MiniMax-M");
}

async function listSettingsFiles(cutoffMs: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".settings.json")) {
        try {
          if ((await stat(path)).mtimeMs >= cutoffMs) out.push(path);
        } catch {
          // File may disappear during a Droid write.
        }
      }
    }
  };
  for (const root of factoryRoots()) await walk(join(root, "sessions"));
  return out;
}

async function sessionTimestamp(settingsFile: string, fallbackMs: number): Promise<Date> {
  const transcript = join(dirname(settingsFile), basename(settingsFile, ".settings.json") + ".jsonl");
  let text: string;
  try {
    text = await readFile(transcript, "utf8");
  } catch {
    return new Date(fallbackMs);
  }
  let latest = 0;
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"timestamp"')) continue;
    try {
      const value = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "");
      if (Number.isFinite(value)) latest = Math.max(latest, value);
    } catch {
      // Ignore partial writes.
    }
  }
  return new Date(latest || fallbackMs);
}

export async function parseDroidSession(file: string): Promise<DroidSession | null> {
  let settings: DroidSettings;
  let info;
  try {
    // Stat before reading so a concurrent write changes the mtime for the next poll.
    info = await stat(file);
    settings = JSON.parse(await readFile(file, "utf8")) as DroidSettings;
  } catch {
    return null;
  }
  const model = normalizedModel(settings);
  const provider = model ? droidModelProvider(model, settings.providerLock) : null;
  if (!model || !provider) return null;
  const usage = settings.tokenUsage;
  if (!usage) return null;
  return {
    sessionId: basename(file, ".settings.json"),
    model,
    provider,
    billingMode: settings.providerLock && settings.providerLock !== "factory" ? "api" : "subscription",
    at: await sessionTimestamp(file, info.mtimeMs),
    tokens: {
      input: positiveNumber(usage.inputTokens),
      output: positiveNumber(usage.outputTokens),
      cacheRead: positiveNumber(usage.cacheReadTokens),
      cacheWrite: positiveNumber(usage.cacheCreationTokens),
      reasoning: positiveNumber(usage.thinkingTokens)
    },
    mtime: info.mtimeMs
  };
}

function isUnpriceableModel(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; body?: string; message?: string };
  const text = `${err?.body ?? ""} ${err?.message ?? ""}`;
  return (err?.statusCode === 400 || err?.status === 400) && /not found in models\.dev/i.test(text);
}

function emptyTotals(at: string): SummerTotals {
  return { since: at, prepaidUsd: 0, usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 };
}

export type DroidDelta = {
  sessionId: string;
  model: string;
  provider: string;
  billingMode: BillingMode;
  at: Date;
  tokens: DroidTokens;
};

export async function processDroidSessions(
  client: AutumnClient,
  auth: SummerAuth,
  options: { dryRun?: boolean } = {}
): Promise<DroidDelta[]> {
  const dryRun = options.dryRun ?? false;
  const deltas: DroidDelta[] = [];
  const customerId = auth.user?.id;
  if (!customerId) return deltas;
  const files = await listSettingsFiles(Date.now() - RECENT_MS);
  if (files.length === 0) return deltas;

  const state = await readState();
  const tracked = { ...(state.droidSessions ?? {}) };
  const delta = { usageUsd: 0, usageRealUsd: 0, usageSubUsd: 0, inputTokens: 0, outputTokens: 0 };
  let changed = false;

  for (const file of files) {
    const prev = tracked[file];
    let mtime: number;
    try {
      mtime = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (prev && prev.mtime === mtime) continue;
    const session = await parseDroidSession(file);
    if (!session) continue;
    const current = session.tokens;
    const base = prev ?? EMPTY_TOKENS;
    const tokens: DroidTokens = {
      input: Math.max(0, current.input - base.input),
      output: Math.max(0, current.output - base.output),
      cacheRead: Math.max(0, current.cacheRead - base.cacheRead),
      cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
      reasoning: Math.max(0, current.reasoning - base.reasoning)
    };

    if (tokenTotal(tokens) > 0) {
      const planned: DroidDelta = {
        sessionId: session.sessionId,
        model: session.model,
        provider: session.provider,
        billingMode: session.billingMode,
        at: session.at,
        tokens
      };
      if (dryRun) {
        deltas.push(planned);
        continue;
      }
      try {
        const result = await client.trackTokensAt({
          customerId,
          featureId: USAGE_FEATURE,
          modelId: `${session.provider}/${session.model}`,
          timestamp: session.at.getTime(),
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheReadTokens: tokens.cacheRead,
          cacheWriteTokens: tokens.cacheWrite,
          reasoningTokens: tokens.reasoning,
          properties: {
            harness: "droid",
            billing_mode: session.billingMode,
            model: session.model,
            provider: session.provider,
            session_id: session.sessionId,
            source: "droid_session",
            user_email: auth.user?.email
          },
          idempotencyKey: `droid:${customerId}:${session.sessionId}:${current.input}:${current.output}:${current.cacheRead}:${current.cacheWrite}:${current.reasoning}`
        });
        const value = Number((result as { value?: number } | null)?.value) || 0;
        delta.usageUsd += value;
        if (session.billingMode === "api") delta.usageRealUsd += value;
        else delta.usageSubUsd += value;
        delta.inputTokens += tokens.input + tokens.cacheRead;
        delta.outputTokens += tokens.output + tokens.reasoning;
        deltas.push(planned);
      } catch (error) {
        if (isDuplicateIdempotency(error)) {
          log.debug({ action: "droid_skip_duplicate", session: session.sessionId });
        } else if (isUnpriceableModel(error)) {
          log.debug({ action: "droid_skip_unpriceable", model: `${session.provider}/${session.model}` });
        } else {
          log.warn({ action: "droid_usage_track_failed", error: serializeError(error), session: session.sessionId });
          continue;
        }
      }
    } else if (dryRun) {
      continue;
    }
    tracked[file] = { mtime: session.mtime, ...current };
    changed = true;
  }

  if (dryRun || !changed) return deltas;
  const fresh = await readState();
  const previous = fresh.totals ?? emptyTotals(new Date().toISOString());
  const trackedTokens = delta.inputTokens + delta.outputTokens > 0;
  await writeState({
    ...fresh,
    droidSessions: tracked,
    liveTrackingSince: fresh.liveTrackingSince ?? (trackedTokens ? Date.now() : undefined),
    totals: {
      ...previous,
      usageUsd: previous.usageUsd + delta.usageUsd,
      usageRealUsd: previous.usageRealUsd + delta.usageRealUsd,
      usageSubUsd: previous.usageSubUsd + delta.usageSubUsd,
      inputTokens: previous.inputTokens + delta.inputTokens,
      outputTokens: previous.outputTokens + delta.outputTokens
    }
  });
  return deltas;
}
