import type { AutumnClient } from "../clients/autumn.ts";
import { USAGE_FEATURE, toModelId } from "../config/constants.ts";
import { readState, writeState } from "../config/storage.ts";
import type { SummerAuth, SummerUsageEvent } from "../domain/types.ts";
import { log, serializeError } from "../logging/logger.ts";

/** A 409 duplicate idempotency key means the event was already recorded — treat as benign. */
export function isDuplicateIdempotency(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; body?: string; message?: string };
  const text = `${err?.body ?? ""} ${err?.message ?? ""}`;
  return err?.statusCode === 409 || err?.status === 409 || text.includes("duplicate_idempotency_key");
}

function compactProperties(event: SummerUsageEvent, auth: SummerAuth) {
  return {
    harness: event.harness,
    model: event.model,
    billing_mode: event.billingMode,
    request_id: event.requestId,
    session_id: event.sessionId,
    source: event.source,
    user_email: auth.user?.email,
    cache_read_tokens: event.cacheReadTokens,
    cache_write_tokens: event.cacheWriteTokens
  };
}

function eventKey(event: SummerUsageEvent) {
  return (
    event.requestId ??
    event.sessionId ??
    `${event.harness}:${event.model ?? "unknown"}:${event.inputTokens ?? 0}:${event.outputTokens ?? 0}`
  );
}

export async function trackUsageEvent(client: AutumnClient, auth: SummerAuth, event: SummerUsageEvent) {
  const customerId = auth.user?.id;
  if (!customerId) throw new Error("Summer auth is missing user.id");

  const inputTokens = event.inputTokens ?? 0;
  const outputTokens = event.outputTokens ?? 0;
  const cacheReadTokens = event.cacheReadTokens ?? 0;
  const cacheWriteTokens = event.cacheWriteTokens ?? 0;
  if (!event.model || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) {
    log.debug({
      action: "usage_track_skipped",
      reason: !event.model ? "no_model" : "no_tokens",
      harness: event.harness,
      requestId: event.requestId
    });
    return;
  }

  const props = compactProperties(event, auth);
  const key = eventKey(event);

  // Autumn prices the tokens via Models.dev and records the value on usage_in_usd.
  // `billing_mode` tags whether this is real spend (api) or api-equivalent value (subscription).
  // The idempotency key makes re-delivery a benign no-op (409 -> skip, no double-count).
  let trackedValueUsd = 0;
  try {
    // Stamp at the harness event's usage time (falling back to now) so the event lands on the day it
    // happened — keeps live day-bucketing consistent with backfill (and avoids day-boundary overlap).
    const res = await client.trackTokensAt({
      customerId,
      featureId: USAGE_FEATURE,
      modelId: toModelId(event.harness, event.model),
      timestamp: event.timestampMs ?? Date.now(),
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: event.reasoningTokens,
      properties: props,
      idempotencyKey: `${key}:usage`
    });
    trackedValueUsd = Number((res as { value?: number } | null)?.value) || 0;
  } catch (error) {
    if (isDuplicateIdempotency(error)) {
      log.debug({
        action: "usage_event_skipped_duplicate",
        harness: event.harness,
        requestId: event.requestId
      });
      return;
    }
    log.warn({
      action: "usage_track_failed",
      error: serializeError(error),
      harness: event.harness,
      model: event.model,
      requestId: event.requestId
    });
    return;
  }

  log.debug({
    action: "usage_tracked",
    harness: event.harness,
    billingMode: event.billingMode,
    model: event.model,
    valueUsd: trackedValueUsd,
    inputTokens,
    outputTokens,
    customerId,
    requestId: event.requestId
  });

  const state = await readState();
  const at = new Date().toISOString();
  const prev = state.totals ?? {
    since: at,
    prepaidUsd: 0,
    usageUsd: 0,
    usageRealUsd: 0,
    usageSubUsd: 0,
    inputTokens: 0,
    outputTokens: 0
  };
  const totals = {
    ...prev,
    usageUsd: prev.usageUsd + trackedValueUsd,
    usageRealUsd: prev.usageRealUsd + (event.billingMode === "api" ? trackedValueUsd : 0),
    usageSubUsd: prev.usageSubUsd + (event.billingMode === "subscription" ? trackedValueUsd : 0),
    inputTokens: prev.inputTokens + inputTokens,
    outputTokens: prev.outputTokens + outputTokens
  };
  await writeState({
    ...state,
    // Mark when live tracking first recorded usage, so `backfill` auto-caps here (no overlap).
    liveTrackingSince: state.liveTrackingSince ?? Date.now(),
    totals,
    lastEvent: {
      at,
      requestId: event.requestId,
      model: event.model,
      estimatedValueUsd: event.estimatedCostUsd
    },
    lastEvents: {
      ...state.lastEvents,
      [event.harness]: {
        at,
        harness: event.harness,
        requestId: event.requestId,
        sessionId: event.sessionId,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostUsd: event.estimatedCostUsd
      }
    }
  });
}
