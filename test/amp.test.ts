import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ampThreadDirs, collectAmpRecords, normalizeAmpModel, parseAmpThread } from "../src/integrations/amp/sessions.ts";

const thread = (messages: unknown[]) => JSON.stringify({ id: "T-1", created: 1, messages });
const assistant = (over: Record<string, unknown> = {}) => ({
  role: "assistant", messageId: 3,
  usage: { model: "accounts/fireworks/models/kimi-k2p5", timestamp: "2026-07-10T10:00:00Z", inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 },
  ...over
});

test("parseAmpThread maps per-message usage without double-counting total input", () => {
  const records = parseAmpThread(thread([assistant()]));
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ id: "T-1:3", threadId: "T-1", provider: "fireworks", model: "kimi-k2p5" });
  expect(records[0].tokens).toEqual({ input: 10, output: 4, cacheRead: 20, cacheWrite: 5 });
});

test("parseAmpThread skips malformed, user, zero-token, and unknown-model records", () => {
  expect(parseAmpThread("not json")).toEqual([]);
  expect(parseAmpThread(thread([{ ...assistant(), role: "user" }, assistant({ messageId: 4, usage: { model: "unknown", timestamp: "2026-07-10", inputTokens: 1 } }), assistant({ messageId: 5, usage: { model: "claude-sonnet-4-6", timestamp: "2026-07-10", inputTokens: 0 } })]))).toEqual([]);
  expect(normalizeAmpModel("gpt-5.4")).toEqual({ provider: "openai", model: "gpt-5.4" });
});

test("collectAmpRecords honors AMP_DATA_DIR and file mtime window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summer-amp-"));
  await mkdir(join(dir, "threads"));
  await writeFile(join(dir, "threads", "T-1.json"), thread([assistant()]));
  process.env.AMP_DATA_DIR = dir;
  try {
    expect(await collectAmpRecords(0)).toHaveLength(1);
    expect(await collectAmpRecords(Date.now() + 1000)).toHaveLength(0);
  } finally { delete process.env.AMP_DATA_DIR; }
});

test("collectAmpRecords filters old messages inside recently-touched threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summer-amp-window-"));
  await mkdir(join(dir, "threads"));
  const old = assistant({ messageId: 1, usage: { model: "gpt-5.4", timestamp: "2020-01-01T00:00:00Z", inputTokens: 1 } });
  const recent = assistant({ messageId: 2, usage: { model: "gpt-5.4", timestamp: new Date().toISOString(), inputTokens: 1 } });
  await writeFile(join(dir, "threads", "T-1.json"), thread([old, recent]));
  process.env.AMP_DATA_DIR = dir;
  try { expect((await collectAmpRecords(Date.now() - 60_000)).map((r) => r.id)).toEqual(["T-1:2"]); }
  finally { delete process.env.AMP_DATA_DIR; }
});

test("ampThreadDirs ignores empty AMP_DATA_DIR segments before joining", () => {
  process.env.AMP_DATA_DIR = " /tmp/amp-a, ,/tmp/amp-b, ";
  try { expect(ampThreadDirs()).toEqual(["/tmp/amp-a/threads", "/tmp/amp-b/threads"]); }
  finally { delete process.env.AMP_DATA_DIR; }
});
