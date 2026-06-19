import type { BillingMode, SummerUsageEvent } from "../../domain/types.ts";
import { logRecordAttributes, numberAttr, otelTimestampMs, stringAttr, visitLogRecords } from "../../telemetry/otlp.ts";

/**
 * Classify a Claude Code request as subscription vs api.
 * Per the OTel docs, OAuth/subscription sessions populate user.email / account / org
 * attributes; API-key (and Bedrock/Vertex) sessions populate only user.id + session.id.
 */
function inferBillingMode(attrs: Record<string, unknown>, env: NodeJS.ProcessEnv): BillingMode {
  if (
    stringAttr(attrs, "user.email") ||
    stringAttr(attrs, "user.account_uuid") ||
    stringAttr(attrs, "user.account_id") ||
    stringAttr(attrs, "organization.id")
  ) {
    return "subscription";
  }
  if (env.ANTHROPIC_API_KEY) return "api";
  // No Claude account in the session => api key / Bedrock / Vertex.
  return "api";
}

export function parseClaudeUsageEvents(
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env
): SummerUsageEvent[] {
  const events: SummerUsageEvent[] = [];
  for (const record of visitLogRecords(payload)) {
    const attrs = logRecordAttributes(record);
    const eventName =
      stringAttr(attrs, "event.name") ??
      stringAttr(attrs, "event_name") ??
      stringAttr(attrs, "name");
    if (eventName !== "api_request" && eventName !== "claude_code.api_request") {
      continue;
    }

    events.push({
      harness: "claude_code",
      model: stringAttr(attrs, "model"),
      estimatedCostUsd: numberAttr(attrs, "cost_usd"),
      inputTokens: numberAttr(attrs, "input_tokens") ?? 0,
      outputTokens: numberAttr(attrs, "output_tokens") ?? 0,
      cacheReadTokens: numberAttr(attrs, "cache_read_tokens") ?? 0,
      cacheWriteTokens:
        numberAttr(attrs, "cache_creation_tokens") ??
        numberAttr(attrs, "cache_write_tokens") ??
        0,
      billingMode: inferBillingMode(attrs, env),
      requestId: stringAttr(attrs, "request_id"),
      sessionId: stringAttr(attrs, "session.id") ?? stringAttr(attrs, "session_id"),
      source: stringAttr(attrs, "query_source"),
      timestampMs: otelTimestampMs(attrs),
      raw: attrs
    });
  }
  return events;
}
