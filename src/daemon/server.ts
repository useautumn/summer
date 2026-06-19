import { Hono } from "hono";
import { AutumnClient } from "../clients/autumn.ts";
import { SUMMER_FEATURES } from "../config/constants.ts";
import { readAuth, readState } from "../config/storage.ts";
import { parseClaudeUsageEvents } from "../integrations/claude/otlp.ts";
import { parseCodexUsageEvents } from "../integrations/codex/otlp.ts";
import { createLogger, log, serializeError } from "../logging/logger.ts";
import { trackUsageEvent } from "../tracking/tracker.ts";
import { processClaudeOauthUsage } from "../tracking/oauthUsage.ts";
import { processCodexSessions } from "../integrations/codex/sessions.ts";
import { processOpencodeSessions } from "../integrations/opencode/sessions.ts";
import { syncCustomerMetadata } from "../tracking/metadata.ts";

export async function serveForeground(port = 4318, options: { debug?: boolean } = {}) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "summer" }));
  app.get("/status", async (c) => c.json(await readState()));

  app.post("/v1/logs", async (c) => {
    const ingestLog = createLogger({
      operation: "otlp_ingest",
      method: "POST",
      path: "/v1/logs"
    });

    try {
      const auth = await readAuth();
      if (!auth) {
        ingestLog.setLevel("warn");
        ingestLog.set({ outcome: "unauthenticated" });
        return c.json({ error: "Summer is not authenticated" }, 401);
      }
      // Do NOT refresh here. AutumnClient handles 401 + token refresh through the cross-process
      // single-flight lock; refreshing in this handler too would be a second, uncoordinated
      // refresher that races the pollers/dash (burning the rotating refresh token → invalid_grant)
      // and 500s the whole request on failure. An expired token self-heals on the first 401.

      const payload = await c.req.json();
      const events = [
        ...parseClaudeUsageEvents(payload),
        ...parseCodexUsageEvents(payload)
      ];
      ingestLog.set({
        customerId: auth.user?.id,
        parsedEvents: events.length,
        harnesses: [...new Set(events.map((event) => event.harness))],
        models: [...new Set(events.map((event) => event.model).filter(Boolean))]
      });

      const client = new AutumnClient(auth);
      let tracked = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await trackUsageEvent(client, auth, event);
          tracked += 1;
        } catch (error) {
          failed += 1;
          ingestLog.set({ lastError: serializeError(error) });
        }
      }

      ingestLog.set({
        outcome: failed > 0 ? "partial" : "accepted",
        trackedEvents: tracked,
        failedEvents: failed
      });
      return c.json({ accepted: tracked, failed });
    } catch (error) {
      ingestLog.setLevel("error");
      ingestLog.set({
        outcome: "failed",
        error: serializeError(error)
      });
      throw error;
    } finally {
      ingestLog.emit();
    }
  });

  // Ensure the customer exists on startup — resilient to a reseeded Autumn / fresh org,
  // so tracking never fails against a missing customer after a restart.
  try {
    const startupAuth = await readAuth();
    if (startupAuth?.user?.id) {
      await new AutumnClient(startupAuth).getOrCreateCustomer(startupAuth.user);
    }
  } catch (error) {
    log.warn({ action: "daemon_ensure_customer_failed", error: serializeError(error) });
  }

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch
  });
  log.info({
    action: "daemon_listening",
    url: `http://127.0.0.1:${port}`,
    debug: options.debug ?? false
  });
  console.log(`Summer daemon listening on http://127.0.0.1:${port}`);

  // Poll the Claude subscription usage endpoint sparsely (it is aggressively rate-limited):
  // surfaces plan utilization + auto-reconciles extra-usage (overage credit) spend into prepaid_spend.
  const usageIntervalMs = Math.max(180_000, Number(process.env.SUMMER_OAUTH_USAGE_INTERVAL_MS ?? 300_000));
  const pollClaudeUsage = async () => {
    try {
      const usageAuth = await readAuth();
      if (!usageAuth) return;
      await processClaudeOauthUsage(new AutumnClient(usageAuth), usageAuth);
    } catch (error) {
      log.warn({ action: "oauth_usage_poll_error", error: serializeError(error) });
    }
  };
  setTimeout(pollClaudeUsage, 10_000);
  setInterval(pollClaudeUsage, usageIntervalMs);

  // Poll Codex session JSONL (cheap file reads, no rate limit) for per-turn token usage.
  const codexIntervalMs = Math.max(15_000, Number(process.env.SUMMER_CODEX_INTERVAL_MS ?? 30_000));
  const pollCodex = async () => {
    try {
      const codexAuth = await readAuth();
      if (!codexAuth) return;
      await processCodexSessions(new AutumnClient(codexAuth), codexAuth);
    } catch (error) {
      log.warn({ action: "codex_poll_error", error: serializeError(error) });
    }
  };
  setTimeout(pollCodex, 5_000);
  setInterval(pollCodex, codexIntervalMs);

  // Poll opencode session message JSON (per-message token counts) for live usage.
  const opencodeIntervalMs = Math.max(15_000, Number(process.env.SUMMER_OPENCODE_INTERVAL_MS ?? 30_000));
  const pollOpencode = async () => {
    try {
      const ocAuth = await readAuth();
      if (!ocAuth) return;
      await processOpencodeSessions(new AutumnClient(ocAuth), ocAuth);
    } catch (error) {
      log.warn({ action: "opencode_poll_error", error: serializeError(error) });
    }
  };
  setTimeout(pollOpencode, 7_000);
  setInterval(pollOpencode, opencodeIntervalMs);

  // Cron: sync plan + usage% onto the Autumn customer metadata (for the dashboard to read).
  const metadataIntervalMs = Math.max(60_000, Number(process.env.SUMMER_METADATA_INTERVAL_MS ?? 5 * 60_000));
  const pollMetadata = async () => {
    try {
      const metaAuth = await readAuth();
      if (!metaAuth) return;
      await syncCustomerMetadata(new AutumnClient(metaAuth), metaAuth);
    } catch (error) {
      log.warn({ action: "metadata_sync_error", error: serializeError(error) });
    }
  };
  setTimeout(pollMetadata, 20_000); // after the first usage + codex polls populate state
  setInterval(pollMetadata, metadataIntervalMs);

  await new Promise(() => undefined);
}

export async function setupSummerFeatures(client: AutumnClient) {
  const remoteFeatures = await client.listFeatures();
  const existingFeatureIds = new Set(remoteFeatures.list.map((feature) => feature.id));
  const result = {
    created: [] as string[],
    updated: [] as string[]
  };

  for (const feature of SUMMER_FEATURES) {
    if (existingFeatureIds.has(feature.id)) {
      await client.updateFeature(feature.id, featureToSdkParams(feature));
      result.updated.push(feature.id);
      log.debug({ action: "feature_updated", featureId: feature.id });
      continue;
    }

    try {
      await client.createFeature(featureToSdkParams(feature));
      result.created.push(feature.id);
      log.debug({ action: "feature_created", featureId: feature.id });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("duplicate_feature_id")
      ) {
        await client.updateFeature(feature.id, featureToSdkParams(feature));
        result.updated.push(feature.id);
        log.debug({ action: "feature_updated_after_duplicate", featureId: feature.id });
        continue;
      }
      throw error;
    }
  }

  return result;
}

function featureToSdkParams(feature: (typeof SUMMER_FEATURES)[number]) {
  return {
    featureId: feature.id,
    name: feature.name,
    type: feature.type,
    consumable: feature.consumable
  };
}
