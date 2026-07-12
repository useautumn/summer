import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPiRecords, normalizePiModel, normalizePiProvider, parsePiSession } from "../src/integrations/pi/sessions.ts";

const line = (v: unknown) => JSON.stringify(v);
const fixture = [
  line({ type: "session", id: "S-1", timestamp: "2026-07-10T10:00:00Z" }),
  line({ type: "message", id: "u", timestamp: "2026-07-10T10:00:01Z", message: { role: "user" } }),
  line({ type: "message", id: "a", timestamp: "2026-07-10T10:00:02Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.4", timestamp: Date.parse("2026-07-10T10:00:03Z"), usage: { input: 10, output: 4, cacheRead: 20, cacheWrite: 5 } } }),
  "partial {",
  line({ type: "message", id: "z", timestamp: "2026-07-10T10:00:04Z", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", usage: { input: 0, output: 0 } } })
].join("\n");

test("parsePiSession extracts assistant usage and prefers message timestamp", () => {
  const records = parsePiSession(fixture);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ id: "S-1:a", sessionId: "S-1", provider: "openai", model: "gpt-5.4", billingMode: "subscription", createdMs: Date.parse("2026-07-10T10:00:03Z") });
  expect(records[0].tokens).toEqual({ input: 10, output: 4, cacheRead: 20, cacheWrite: 5 });
});

test("normalizePiProvider only aliases known broker ids", () => {
  expect(normalizePiProvider("openai-codex")).toBe("openai");
  expect(normalizePiProvider("anthropic")).toBe("anthropic");
  expect(normalizePiProvider("google-gemini-cli")).toBe("google");
  expect(normalizePiModel("fireworks", "accounts/fireworks/routers/kimi-k2p5-turbo")).toBe("kimi-k2p5-turbo");
});

test("collectPiRecords honors PI_CODING_AGENT_SESSION_DIR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summer-pi-"));
  await mkdir(join(dir, "project"));
  await writeFile(join(dir, "project", "session.jsonl"), fixture);
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  try { expect(await collectPiRecords(0)).toHaveLength(1); }
  finally { delete process.env.PI_CODING_AGENT_SESSION_DIR; }
});

test("collectPiRecords filters old messages inside recently-touched sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summer-pi-window-"));
  await mkdir(join(dir, "project"));
  const session = [
    line({ type: "session", id: "S-1" }),
    line({ type: "message", id: "old", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.4", timestamp: Date.parse("2020-01-01T00:00:00Z"), usage: { input: 1 } } }),
    line({ type: "message", id: "recent", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.4", timestamp: Date.now(), usage: { input: 1 } } })
  ].join("\n");
  await writeFile(join(dir, "project", "session.jsonl"), session);
  process.env.PI_CODING_AGENT_SESSION_DIR = dir;
  try { expect((await collectPiRecords(Date.now() - 60_000)).map((r) => r.id)).toEqual(["S-1:recent"]); }
  finally { delete process.env.PI_CODING_AGENT_SESSION_DIR; }
});
