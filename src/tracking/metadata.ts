import type { AutumnClient } from "../clients/autumn.ts";
import { fetchClaudeSubscription } from "../clients/claudeOauthUsage.ts";
import { planFromRateLimitTier } from "../config/constants.ts";
import { readState } from "../config/storage.ts";
import type { SummerAuth } from "../domain/types.ts";
import { log, serializeError } from "../logging/logger.ts";

/**
 * Cron-style sync of plan + usage-percentage info onto the Autumn customer's metadata, so the
 * dashboard can read per-developer plan/utilization. Best-effort; rewrites the summer metadata block.
 */
export async function syncCustomerMetadata(client: AutumnClient, auth: SummerAuth) {
  const customerId = auth.user?.id;
  if (!customerId) return;

  const state = await readState();
  const sub = await fetchClaudeSubscription().catch(() => null);
  const plan = sub ? planFromRateLimitTier(sub.rateLimitTier) : null;
  const claude = state.oauthUsage;
  const codex = state.codexUsage;

  const metadata: Record<string, unknown> = {
    summer: true,
    autumnUserId: customerId,
    updated_at: new Date().toISOString()
  };
  if (sub) metadata.claude_plan_tier = sub.rateLimitTier;
  if (plan) metadata.claude_plan = plan.name;
  if (claude) {
    if (claude.fiveHourPct != null) metadata.claude_5h_pct = claude.fiveHourPct;
    if (claude.sevenDayPct != null) metadata.claude_7d_pct = claude.sevenDayPct;
    metadata.claude_extra_usage_usd = claude.spendUsedUsd;
    metadata.claude_extra_usage_enabled = claude.spendEnabled;
  }
  if (codex) {
    if (codex.fiveHourPct != null) metadata.codex_5h_pct = codex.fiveHourPct;
    if (codex.sevenDayPct != null) metadata.codex_7d_pct = codex.sevenDayPct;
    if (codex.planType) metadata.codex_plan = codex.planType;
  }

  try {
    await client.updateCustomer(customerId, metadata);
    log.debug({ action: "customer_metadata_synced", customerId, claudePlan: plan?.name, codexPlan: codex?.planType });
  } catch (error) {
    log.warn({ action: "customer_metadata_sync_failed", error: serializeError(error) });
  }
}
