import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherOpencodeRecords, parseMessageFile } from "../src/integrations/opencode/sessions.ts";

const assistant = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    providerID: "anthropic",
    modelID: "claude-opus-4-8",
    time: { created: Date.parse("2026-06-10T10:00:00.000Z") },
    cost: 0,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 2, write: 3 } },
    ...over
  });

test("parseMessageFile extracts assistant token usage + provider/model", () => {
  const m = parseMessageFile(assistant());
  expect(m).not.toBeNull();
  expect(m!.providerID).toBe("anthropic");
  expect(m!.modelID).toBe("claude-opus-4-8");
  expect(m!.tokens).toEqual({ input: 100, output: 20, reasoning: 5, cacheRead: 2, cacheWrite: 3 });
});

test("parseMessageFile skips non-assistant / no-model / malformed", () => {
  expect(parseMessageFile(JSON.stringify({ id: "m", role: "user", time: { created: 1 } }))).toBeNull();
  expect(parseMessageFile(assistant({ modelID: undefined }))).toBeNull();
  expect(parseMessageFile("not json")).toBeNull();
});

test("gatherOpencodeRecords reads storage/message, honors [since, until), skips zero/user", async () => {
  const dir = await mkdtemp(join(tmpdir(), "summer-oc-"));
  const msgDir = join(dir, "storage", "message", "ses_1");
  await mkdir(msgDir, { recursive: true });
  const at = (iso: string) => Date.parse(iso);
  await writeFile(join(msgDir, "msg_1.json"), assistant({ id: "msg_1", time: { created: at("2026-06-10T10:00:00Z") } }));
  await writeFile(join(msgDir, "msg_2.json"), assistant({ id: "msg_2", providerID: "openai", modelID: "gpt-5.5", time: { created: at("2026-06-12T10:00:00Z") } }));
  await writeFile(join(msgDir, "msg_zero.json"), assistant({ id: "z", time: { created: at("2026-06-11T10:00:00Z") }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
  await writeFile(join(msgDir, "msg_user.json"), JSON.stringify({ id: "u", role: "user", time: { created: at("2026-06-11T10:00:00Z") } }));

  process.env.OPENCODE_DATA_DIR = dir;
  try {
    const all = await gatherOpencodeRecords({});
    expect(all.map((m) => m.id).sort()).toEqual(["msg_1", "msg_2"]); // zero-token + user dropped

    const windowed = await gatherOpencodeRecords({
      since: new Date("2026-06-11T00:00:00Z"),
      until: new Date("2026-06-13T00:00:00Z")
    });
    expect(windowed.map((m) => m.id)).toEqual(["msg_2"]);
    expect(windowed[0].providerID).toBe("openai");
  } finally {
    process.env.OPENCODE_DATA_DIR = undefined;
  }
});
