import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { droidModelProvider, gatherDroidRecords, parseDroidSession } from "../src/integrations/droid/sessions.ts";

async function makeSession(
  root: string,
  id: string,
  settings: Record<string, unknown>,
  timestamp = "2026-07-10T12:00:00.000Z"
) {
  const dir = join(root, "sessions", "project");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.settings.json`);
  await writeFile(file, JSON.stringify(settings));
  await writeFile(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ type: "session_start", id })}\n${JSON.stringify({ type: "message", timestamp })}\n`
  );
  return file;
}

test("parseDroidSession reads direct session usage without inclusive child totals", async () => {
  const root = await mkdtemp(join(tmpdir(), "summer-droid-"));
  const file = await makeSession(root, "session-1", {
    model: "claude-opus-4-7",
    providerLock: "factory",
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationTokens: 3,
      cacheReadTokens: 40,
      thinkingTokens: 5
    },
    inclusiveTokenUsage: { inputTokens: 999999 }
  });

  const session = await parseDroidSession(file);
  expect(session).not.toBeNull();
  expect(session!.sessionId).toBe("session-1");
  expect(session!.model).toBe("claude-opus-4-7");
  expect(session!.provider).toBe("anthropic");
  expect(session!.billingMode).toBe("subscription");
  expect(session!.at.toISOString()).toBe("2026-07-10T12:00:00.000Z");
  expect(session!.tokens).toEqual({ input: 100, output: 20, cacheRead: 40, cacheWrite: 3, reasoning: 5 });
});

test("Droid auto/custom models resolve to Models.dev providers", async () => {
  expect(droidModelProvider("gpt-5.5", "factory")).toBe("openai");
  expect(droidModelProvider("glm-5.2", "factory")).toBe("zhipuai");
  expect(droidModelProvider("MiniMax-M2.7", "factory")).toBe("minimax");
  expect(droidModelProvider("deepseek-v4-pro", "factory")).toBe("deepseek");
  expect(droidModelProvider("unknown-model", "factory")).toBeNull();

  const root = await mkdtemp(join(tmpdir(), "summer-droid-"));
  const auto = await makeSession(root, "auto", {
    model: "auto",
    providerLock: "factory",
    effectiveFactoryRouterModel: { modelId: "glm-5.2", apiProvider: "fireworks" },
    tokenUsage: { inputTokens: 1 }
  });
  const custom = await makeSession(root, "custom", {
    model: "custom:claude-opus-4-6-0",
    providerLock: "anthropic",
    tokenUsage: { outputTokens: 2 }
  });
  expect((await parseDroidSession(auto))?.model).toBe("glm-5.2");
  expect((await parseDroidSession(custom))?.model).toBe("claude-opus-4-6");
  expect((await parseDroidSession(custom))?.billingMode).toBe("api");

  const minimax = await makeSession(root, "minimax", {
    model: "minimax-m2.7",
    providerLock: "factory",
    tokenUsage: { inputTokens: 3 }
  });
  expect((await parseDroidSession(minimax))?.model).toBe("MiniMax-M2.7");
});

test("gatherDroidRecords windows by last activity and excludes live-tracked sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "summer-droid-"));
  const inRange = await makeSession(
    root,
    "in-range",
    { model: "claude-opus-4-7", providerLock: "factory", tokenUsage: { inputTokens: 10 } },
    "2026-07-05T10:00:00.000Z"
  );
  const tracked = await makeSession(
    root,
    "tracked",
    { model: "claude-opus-4-7", providerLock: "factory", tokenUsage: { inputTokens: 20 } },
    "2026-07-05T11:00:00.000Z"
  );
  await makeSession(
    root,
    "too-new",
    { model: "claude-opus-4-7", providerLock: "factory", tokenUsage: { inputTokens: 30 } },
    "2026-07-09T10:00:00.000Z"
  );
  await makeSession(root, "no-usage", { model: "claude-opus-4-7", providerLock: "factory" });

  const prev = process.env.FACTORY_DATA_DIR;
  process.env.FACTORY_DATA_DIR = root;
  try {
    const records = await gatherDroidRecords({
      until: new Date("2026-07-08T00:00:00.000Z"),
      excludeFiles: new Set([tracked])
    });
    expect(records.map((r) => r.file)).toEqual([inRange]);
    expect(records[0].tokens.input).toBe(10);
    expect(records[0].at.toISOString()).toBe("2026-07-05T10:00:00.000Z");
  } finally {
    if (prev === undefined) delete process.env.FACTORY_DATA_DIR;
    else process.env.FACTORY_DATA_DIR = prev;
  }
});
