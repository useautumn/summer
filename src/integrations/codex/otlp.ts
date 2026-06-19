import type { BillingMode, SummerUsageEvent } from "../../domain/types.ts";
import { logRecordAttributes, numberAttr, otelTimestampMs, stringAttr, visitLogRecords } from "../../telemetry/otlp.ts";

function inferBillingMode(attrs: Record<string, unknown>): BillingMode {
  const authMode = stringAttr(attrs, "auth_mode", "auth.mode", "codex.auth_mode");
  if (authMode === "api") return "api";
  // swic / chatgpt / absent => ChatGPT subscription
  return "subscription";
}

function isCodexUsageEvent(attrs: Record<string, unknown>) {
  const eventName = stringAttr(attrs, "event.name", "event_name", "name") ?? "";
  const eventType = stringAttr(attrs, "type", "event.type", "sse.event") ?? "";
  if (eventName === "codex.sse_event" || eventName === "sse_event") {
    return eventType === "response.completed" || eventType === "completed";
  }
  return eventName === "codex.response.completed" || eventName === "response.completed";
}

export function parseCodexUsageEvents(payload: unknown): SummerUsageEvent[] {
  const events: SummerUsageEvent[] = [];
  for (const record of visitLogRecords(payload)) {
    const attrs = logRecordAttributes(record);
    if (!isCodexUsageEvent(attrs)) continue;

    const inputTokens = numberAttr(
      attrs,
      "input_tokens",
      "inputTokens",
      "usage.input_tokens",
      "gen_ai.usage.input_tokens",
      "prompt_tokens"
    );
    const outputTokens = numberAttr(
      attrs,
      "output_tokens",
      "outputTokens",
      "usage.output_tokens",
      "gen_ai.usage.output_tokens",
      "completion_tokens"
    );

    if (!inputTokens && !outputTokens) continue;

    events.push({
      harness: "codex",
      model: stringAttr(attrs, "model", "gen_ai.request.model", "response.model"),
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      cacheReadTokens:
        numberAttr(attrs, "cached_input_tokens", "cache_read_tokens", "usage.cached_input_tokens") ?? 0,
      reasoningTokens: numberAttr(attrs, "reasoning_output_tokens", "reasoning_tokens"),
      billingMode: inferBillingMode(attrs),
      requestId: stringAttr(attrs, "request_id", "response.id", "gen_ai.response.id"),
      sessionId: stringAttr(attrs, "session.id", "session_id", "conversation.id"),
      source: stringAttr(attrs, "event.name", "event_name"),
      timestampMs: otelTimestampMs(attrs),
      raw: attrs
    });
  }
  return events;
}
