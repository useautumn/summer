import type { AutumnClient } from "../clients/autumn.ts";
import { fetchClaudeUsage } from "../clients/claudeOauthUsage.ts";
import { readState, writeState } from "../config/storage.ts";
import type { SummerAuth } from "../domain/types.ts";

/**
 * Poll Claude's usage endpoint and cache plan utilization (5h / 7d windows) for `summer report`.
 * Prepaid / extra-usage SPEND tracking is intentionally disabled — Summer is usage-only for now.
 */
export async function processClaudeOauthUsage(_client: AutumnClient, auth: SummerAuth) {
  if (!auth.user?.id) return;
  const snap = await fetchClaudeUsage();
  if (!snap) return;

  const state = await readState();
  await writeState({
    ...state,
    oauthUsage: {
      at: snap.at,
      fiveHourPct: snap.fiveHourPct,
      sevenDayPct: snap.sevenDayPct,
      spendUsedUsd: snap.spend.usedUsd,
      spendEnabled: snap.spend.enabled,
      limits: snap.limits.map((l) => ({
        kind: l.kind,
        percent: l.percent,
        severity: l.severity,
        resets_at: l.resets_at,
        is_active: l.is_active
      }))
    }
  });
}
