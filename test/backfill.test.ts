import { expect, test } from "bun:test";
import { collectClaudeRecords } from "../src/integrations/claude/transcripts.ts";
import { parseSessionTimeline } from "../src/integrations/codex/sessions.ts";
import { idempotencyModelOf } from "../src/tracking/backfill.ts";

test("backfill idempotency keeps legacy model keys unless provider disambiguation is needed", () => {
  expect(idempotencyModelOf({ model: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  expect(idempotencyModelOf({ model: "gpt-5.4", provider: "openai" })).toBe("openai/gpt-5.4");
});

test("collectClaudeRecords dedups by (message.id, requestId) and skips synthetic", () => {
  const line = (id: string, req: string, model: string, ts: string, inTok: number) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      requestId: req,
      message: { id, model, usage: { input_tokens: inTok, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } }
    });
  const text = [
    line("msg_1", "req_1", "claude-opus-4-8", "2026-06-10T10:00:00.000Z", 100),
    line("msg_1", "req_1", "claude-opus-4-8", "2026-06-10T10:00:00.000Z", 100), // duplicate -> dropped
    line("msg_2", "req_2", "claude-opus-4-8", "2026-06-10T11:00:00.000Z", 50),
    line("msg_3", "req_3", "<synthetic>", "2026-06-10T12:00:00.000Z", 999), // synthetic -> dropped
    JSON.stringify({ type: "user", message: { content: "hi" } }) // not assistant -> dropped
  ].join("\n");

  const recs = collectClaudeRecords(text, new Set());
  expect(recs.length).toBe(2);
  expect(recs[0].messageId).toBe("msg_1");
  expect(recs[0].inputTokens).toBe(100);
  expect(recs[0].cacheReadTokens).toBe(2);
  expect(recs[0].cacheWriteTokens).toBe(3);
  expect(recs[1].messageId).toBe("msg_2");
});

test("collectClaudeRecords honors [since, until) by line timestamp", () => {
  const text = [
    JSON.stringify({ type: "assistant", timestamp: "2026-06-09T10:00:00.000Z", requestId: "a", message: { id: "1", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-10T10:00:00.000Z", requestId: "b", message: { id: "2", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-06-11T10:00:00.000Z", requestId: "c", message: { id: "3", model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } } })
  ].join("\n");
  const recs = collectClaudeRecords(text, new Set(), {
    since: new Date("2026-06-10T00:00:00.000Z"),
    until: new Date("2026-06-11T00:00:00.000Z")
  });
  expect(recs.map((r) => r.messageId)).toEqual(["2"]);
});

test("parseSessionTimeline yields time-ordered cumulative token_count events with model + billing", () => {
  const tc = (ts: string, info: Record<string, number>, planType: string | null) =>
    JSON.stringify({ type: "event_msg", timestamp: ts, payload: { type: "token_count", info: { total_token_usage: info }, rate_limits: { plan_type: planType } } });
  const text = [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-10T09:59:00.000Z", payload: { id: "sess_1", model_provider: "openai" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-06-10T10:00:00.000Z", payload: { model: "gpt-5.5" } }),
    tc("2026-06-10T10:00:10.000Z", { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_output_tokens: 10 }, "pro"),
    tc("2026-06-10T10:05:00.000Z", { input_tokens: 3000, cached_input_tokens: 900, output_tokens: 120, reasoning_output_tokens: 30 }, "pro")
  ].join("\n");

  const { provider, sessionId, events } = parseSessionTimeline(text);
  expect(provider).toBe("openai");
  expect(sessionId).toBe("sess_1");
  expect(events.length).toBe(2);
  expect(events[0].model).toBe("gpt-5.5");
  expect(events[0].billingMode).toBe("subscription"); // plan_type present
  expect(events[0].cumulative.input).toBe(1000);
  expect(events[1].cumulative.output).toBe(120);

  // The backfiller diffs consecutive cumulatives; verify the delta math the orchestrator relies on.
  const a = events[0].cumulative;
  const b = events[1].cumulative;
  const dCached = b.cachedInput - a.cachedInput; // 700
  const dInputTotal = b.input - a.input; // 2000 (includes cached)
  expect(dInputTotal - dCached).toBe(1300); // non-cached input delta
  expect(b.output - a.output).toBe(70);
});

test("parseSessionTimeline classifies billing at session level (no phantom api split)", () => {
  // First token_count lacks plan_type (rate_limits not yet populated), later one has it.
  const text = [
    JSON.stringify({ type: "turn_context", timestamp: "2026-06-08T00:10:00.000Z", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-08T00:11:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, output_tokens: 5 } }, rate_limits: {} } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-08T00:12:00.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 300, output_tokens: 12 } }, rate_limits: { plan_type: "pro" } } })
  ].join("\n");
  const { events } = parseSessionTimeline(text);
  expect(events.length).toBe(2);
  // BOTH events should be subscription because the session reported plan_type somewhere.
  expect(events.every((e) => e.billingMode === "subscription")).toBe(true);
});

test("parseSessionTimeline marks api billing when no plan_type", () => {
  const text = [
    JSON.stringify({ type: "turn_context", timestamp: "2026-06-10T10:00:00.000Z", payload: { model: "gpt-5.5" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-10T10:00:10.000Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } }, rate_limits: { plan_type: null } } })
  ].join("\n");
  const { events } = parseSessionTimeline(text);
  expect(events[0].billingMode).toBe("api");
});
