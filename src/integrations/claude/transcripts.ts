import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * All Claude data roots to scan, matching ccusage: honor `CLAUDE_CONFIG_DIR` (comma-separated) if set,
 * otherwise default to BOTH `~/.config/claude` and `~/.claude` (newer Claude Code moved to the former).
 * Dedup by (message.id, requestId) across roots makes overlapping dirs safe.
 */
function claudeProjectDirs(): string[] {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  const roots = configured
    ? configured.split(",").map((p) => p.trim()).filter(Boolean)
    : [join(homedir(), ".config", "claude"), join(homedir(), ".claude")];
  return roots.map((root) => join(root, "projects"));
}

/** One assistant turn's token usage, parsed from a Claude Code transcript line. */
export type ClaudeUsageRecord = {
  at: Date;
  model: string;
  messageId?: string;
  requestId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type TranscriptLine = {
  type?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

async function listTranscriptFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

/**
 * Parse one transcript's JSONL `text` into usage records, deduping against the shared `seen` set.
 * Only `type:"assistant"` lines with a `message.usage` block count. The same `(message.id,
 * requestId)` pair appears on multiple lines, so we DEDUP by that pair — otherwise a single
 * response would be counted several times. Synthetic/model-less lines are skipped.
 * `since`/`until` (optional) bound by the per-line ISO timestamp (`[since, until)`).
 */
export function collectClaudeRecords(
  text: string,
  seen: Set<string>,
  opts: { since?: Date; until?: Date } = {}
): ClaudeUsageRecord[] {
  const sinceMs = opts.since?.getTime();
  const untilMs = opts.until?.getTime();
  const records: ClaudeUsageRecord[] = [];

  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const usage = obj.message?.usage;
    const model = obj.message?.model;
    if (!usage || !model || model.startsWith("<")) continue; // skip synthetic / model-less

    const at = obj.timestamp ? new Date(obj.timestamp) : null;
    if (!at || Number.isNaN(at.getTime())) continue;
    const atMs = at.getTime();
    if (sinceMs != null && atMs < sinceMs) continue;
    if (untilMs != null && atMs >= untilMs) continue;

    const dedupKey = `${obj.message?.id ?? ""}:${obj.requestId ?? ""}`;
    if (dedupKey !== ":" && seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    records.push({
      at,
      model,
      messageId: obj.message?.id,
      requestId: obj.requestId,
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: Number(usage.cache_creation_input_tokens ?? 0)
    });
  }

  return records;
}

/**
 * Read all historical Claude Code usage from `~/.claude/projects/**\/*.jsonl` (the ccusage source),
 * deduped across files by `(message.id, requestId)`.
 */
export async function readClaudeUsageRecords(opts: {
  since?: Date;
  until?: Date;
} = {}): Promise<ClaudeUsageRecord[]> {
  const dirs = claudeProjectDirs();
  const files = (await Promise.all(dirs.map(listTranscriptFiles))).flat();
  const seen = new Set<string>();
  const records: ClaudeUsageRecord[] = [];
  const sinceMs = opts.since?.getTime();

  for (const file of files) {
    // Skip files untouched before `since` as a cheap optimisation.
    if (sinceMs != null) {
      try {
        if ((await stat(file)).mtimeMs < sinceMs) continue;
      } catch {
        // fall through and try to read it anyway
      }
    }
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    records.push(...collectClaudeRecords(text, seen, opts));
  }

  return records;
}
