import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getOAuthDebugConfig, login, requireAuth } from "../auth/oauth.ts";
import { AutumnClient } from "../clients/autumn.ts";
import { LOCALHOST, OTLP_PORT, getOtlpPort } from "../config/constants.ts";
import { fetchClaudeUsage } from "../clients/claudeOauthUsage.ts";
import open from "open";
import { serveDash } from "../dash/server.ts";
import {
  clearAuth,
  readAuth,
  readState,
  statePath,
  writeState
} from "../config/storage.ts";
import { serveForeground, setupSummerFeatures } from "../daemon/server.ts";
import { type BackfillResult, type Granularity, type HarnessSelector, runBackfill } from "../tracking/backfill.ts";
import type { BillingMode, SummerAuth } from "../domain/types.ts";
import { patchClaudeSettings, restoreClaudeSettings } from "../integrations/claude/settings.ts";
import { patchCodexSettings, restoreCodexSettings } from "../integrations/codex/settings.ts";
import { choose, confirm, isInteractive } from "./prompts.ts";
import { bold, dim } from "./style.ts";
import { log } from "../logging/logger.ts";

async function ensureCustomer() {
  const auth = await requireAuth();
  if (!auth.user?.id) throw new Error("Summer auth is missing user.id");
  await new AutumnClient(auth).getOrCreateCustomer(auth.user);
  return auth;
}

const orgEnv = (auth: SummerAuth) => `${auth.org?.name ?? "?"} (${auth.org?.env ?? "?"})`;

/**
 * Ensure the user is logged in, has CONFIRMED which Autumn org to use, and that Summer's features +
 * customer exist there. Always prints the org; only prompts when the org isn't confirmed yet (first
 * run or org changed) and the session is interactive (skippable via `yes`). Returns `firstRun` so the
 * caller can run first-time onboarding (e.g. offer backfill).
 */
async function ensureSetup(opts: { yes?: boolean; switchOrg?: boolean } = {}): Promise<{
  auth: SummerAuth;
  firstRun: boolean;
}> {
  if (opts.switchOrg) {
    await stopDaemon().catch(() => undefined);
    await clearAuth();
  }
  let auth = await requireAuth();

  for (;;) {
    if (!auth.user?.id) throw new Error("Summer auth is missing user.id");

    const state = await readState();
    const confirmed = Boolean(state.setup?.orgId && state.setup.orgId === auth.org?.id);
    const client = new AutumnClient(auth);

    console.log();
    console.log(bold("Autumn org"));
    console.log(`  ${auth.org?.name ?? "?"} ${dim(`(${auth.org?.env ?? "?"})`)}`);
    console.log(`  ${dim(auth.user?.email ?? auth.user.id)}`);
    console.log();

    if (!confirmed && !opts.yes && isInteractive()) {
      const action = await choose("Set up Summer here?", [
        { key: "y", label: "es" },
        { key: "s", label: "witch org" },
        { key: "n", label: "o" }
      ]);
      if (action === "s") {
        await clearAuth();
        auth = await login();
        continue; // re-show + re-confirm the new org
      }
      if (action === "n") {
        console.log("Aborted — run `summer setup` when you're ready.");
        process.exit(0);
      }
    }

    // Confirmed already, or just confirmed/`--yes`/non-interactive: seed (idempotent) + remember.
    await setupSummerFeatures(client);
    await client.getOrCreateCustomer(auth.user);
    if (!confirmed) {
      await writeState({
        ...(await readState()),
        setup: { orgId: auth.org?.id ?? "", confirmedAt: new Date().toISOString() }
      });
    }
    return { auth, firstRun: !confirmed };
  }
}

async function canBindPort(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, LOCALHOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function resolveAvailableOtlpPort() {
  const requested = getOtlpPort();
  if (await canBindPort(requested)) return requested;

  if (process.env.SUMMER_OTLP_PORT) {
    throw new Error(`SUMMER_OTLP_PORT ${requested} is already in use.`);
  }

  for (let port = OTLP_PORT + 1; port <= OTLP_PORT + 20; port += 1) {
    if (await canBindPort(port)) {
      log.warn({
        action: "otlp_port_fallback",
        requestedPort: requested,
        selectedPort: port
      });
      return port;
    }
  }

  throw new Error(`No available OTLP port found near ${OTLP_PORT}.`);
}

async function getRunningDaemon() {
  const state = await readState();
  const pid = state.daemon?.pid;
  if (!pid) return null;

  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }

  const port = state.daemon?.port ?? getOtlpPort();
  try {
    const response = await fetch(`http://${LOCALHOST}:${port}/health`);
    if (!response.ok) return null;
  } catch {
    return null;
  }

  return { pid, port };
}

async function waitForDaemon(port: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${LOCALHOST}:${port}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the daemon is ready or exits.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Summer daemon did not become ready on port ${port}.`);
}

async function startDaemon(port: number) {
  const runningDaemon = await getRunningDaemon();
  if (runningDaemon) {
    log.info({
      action: "daemon_already_running",
      pid: runningDaemon.pid,
      port: runningDaemon.port
    });
    return runningDaemon.pid;
  }

  const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const child = spawn(process.execPath, [cliPath, "serve", "--foreground"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SUMMER_OTLP_PORT: String(port) }
  });
  child.unref();
  await waitForDaemon(port);
  await writeState({
    ...(await readState()),
    daemon: { pid: child.pid ?? 0, port, startedAt: new Date().toISOString() }
  });
  log.info({ action: "daemon_spawned", pid: child.pid, port, foreground: false });
  return child.pid;
}

async function stopDaemon() {
  const state = await readState();
  if (state.daemon?.pid) {
    try {
      process.kill(state.daemon.pid, "SIGTERM");
    } catch {
      // already stopped
    }
  }
  await writeState({ ...state, daemon: undefined });
  log.info({ action: "daemon_stopped", pid: state.daemon?.pid });
}

const program = new Command();

program.name("summer").description("Local AI coding usage meter for Autumn.");
program.option("--debug", "Enable Summer debug logs.");

program.command("login").description("Log in to Autumn.").action(async () => {
  const debug = getOAuthDebugConfig();
  console.log(`Using Autumn API: ${debug.apiUrl}`);
  console.log(`Using OAuth client: ${debug.clientId}`);
  const auth = await login();
  console.log(`Logged in to ${auth.org?.name ?? "Autumn"} as ${auth.user?.email ?? auth.user?.id}.`);
});

program.command("logout").description("Log out and clear local Summer auth.").action(async () => {
  await stopDaemon();
  await restoreClaudeSettings();
  await restoreCodexSettings();
  await clearAuth();
  console.log("Logged out of Summer.");
});

program
  .command("setup")
  .description("Confirm your Autumn org and create Summer's usage features there.")
  .option("--yes", "Skip the org confirmation prompt.")
  .option("--switch-org", "Log in again to choose a different Autumn org.")
  .action(async (opts: { yes?: boolean; switchOrg?: boolean }) => {
    const { auth } = await ensureSetup({ yes: opts.yes, switchOrg: opts.switchOrg });
    console.log(`Summer is set up in ${orgEnv(auth)}.`);
  });

program
  .command("usage")
  .description("Show live Claude plan usage + extra-usage spend (from /api/oauth/usage).")
  .action(async () => {
    const snap = await fetchClaudeUsage();
    if (!snap) {
      console.log(
        "Could not read Claude usage — ensure you're logged into Claude Code (token in Keychain); the endpoint is rate-limited, so retry in a few minutes."
      );
      return;
    }
    const line = "─".repeat(48);
    console.log("\nClaude plan usage (live)");
    console.log(line);
    if (snap.fiveHourPct != null) console.log(`5-hour window:   ${snap.fiveHourPct}% used`);
    if (snap.sevenDayPct != null) console.log(`7-day window:    ${snap.sevenDayPct}% used`);
    for (const l of snap.limits.filter((x) => x.is_active)) {
      console.log(`  ${l.kind.padEnd(16)} ${l.percent}% (${l.severity})`);
    }
    console.log(
      snap.spend.enabled
        ? `Extra-usage:     $${snap.spend.usedUsd.toFixed(2)} ${snap.spend.currency} used`
        : "Extra-usage:     disabled (no overage credits)"
    );
    console.log();
  });

program
  .command("report")
  .description("Show this developer's AI usage summary.")
  .action(async () => {
    const auth = await readAuth();
    const state = await readState();
    const t = state.totals;
    const line = "─".repeat(56);
    console.log("\nSummer — AI usage");
    console.log(line);
    console.log(`Developer:    ${auth?.user?.email ?? auth?.user?.id ?? "unknown"}`);
    console.log(`Org / env:    ${auth?.org?.name ?? "?"} (${auth?.org?.env ?? "?"})`);
    const usageUsd = t?.usageUsd ?? 0;
    const usageRealUsd = t?.usageRealUsd ?? 0;
    const usageSubUsd = t?.usageSubUsd ?? 0;
    const inTok = t?.inputTokens ?? 0;
    const outTok = t?.outputTokens ?? 0;
    if (!t || usageUsd === 0) {
      console.log('\nNo usage recorded yet. Run "summer start" and use Claude Code.');
    } else {
      console.log(`Since:        ${t.since}`);
      console.log(line);
      console.log(`Usage value:        $${usageUsd.toFixed(4)}`);
      console.log(`   • subscription:  $${usageSubUsd.toFixed(4)}  (api-equivalent value)`);
      console.log(`   • api key:       $${usageRealUsd.toFixed(4)}  (real spend)`);
      console.log(`Tokens:             ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out`);
    }
    if (state.oauthUsage) {
      const o = state.oauthUsage;
      console.log(line);
      if (o.sevenDayPct != null) console.log(`Plan usage (7d):    ${o.sevenDayPct}% of weekly limit`);
      if (o.fiveHourPct != null) console.log(`Plan usage (5h):    ${o.fiveHourPct}% of session limit`);
    }
    console.log(line);
    console.log(`Dashboard:    ${auth?.appUrl ?? "Autumn dashboard"}`);
    console.log();
  });

function printBackfill(res: BackfillResult) {
  const line = "─".repeat(60);
  console.log(`\nSummer — backfill${res.dryRun ? " (DRY RUN — nothing sent)" : ""}`);
  console.log(line);
  console.log(`Range:        ${res.since ?? "earliest"} → ${res.until}`);
  console.log(`Granularity:  ${res.granularity}`);
  console.log(line);

  // Per-day rollup (UTC) so you can eyeball the shape before/after sending.
  const byDay = new Map<string, { claude: number; codex: number }>();
  for (const b of res.buckets) {
    const day = b.label.slice(0, 10);
    const row = byDay.get(day) ?? { claude: 0, codex: 0 };
    const tok = b.inputTokens + b.outputTokens;
    if (b.harness === "codex") row.codex += tok;
    else row.claude += tok;
    byDay.set(day, row);
  }
  if (byDay.size > 0) {
    console.log(`${"Day".padEnd(12)}${"Claude tok".padStart(14)}${"Codex tok".padStart(14)}`);
    for (const day of [...byDay.keys()].sort()) {
      const r = byDay.get(day)!;
      console.log(`${day.padEnd(12)}${r.claude.toLocaleString().padStart(14)}${r.codex.toLocaleString().padStart(14)}`);
    }
    console.log(line);
  }

  for (const [harness, s] of Object.entries(res.byHarness)) {
    const usd = res.dryRun ? "" : `  $${s.usd.toFixed(4)}`;
    console.log(
      `${harness.padEnd(12)} ${s.buckets} buckets, ${s.inputTokens.toLocaleString()} in / ${s.outputTokens.toLocaleString()} out${usd}`
    );
  }
  console.log(line);
  if (res.dryRun) {
    console.log(`${res.buckets.length} buckets would be sent. Re-run without --dry-run to import.`);
  } else {
    // Backfill sends async, so Autumn prices the events shortly — `value` isn't in the response.
    const usdPart = res.usd > 0 ? `   Total: $${res.usd.toFixed(4)}` : "   (values pricing in Autumn…)";
    console.log(`Sent: ${res.sent}   Skipped (already imported): ${res.skipped}${usdPart}`);
  }
  console.log();
}

program
  .command("backfill")
  .description("Import historical Claude Code + Codex usage into Autumn (backdated, aggregated).")
  .option("--since <date>", "Only backfill usage on/after this date (e.g. 2026-05-01)")
  .option("--until <date>", "Only backfill usage before this date (default: auto-cap at first live event)")
  .option("--granularity <granularity>", "Aggregation bucket: daily | hourly", "daily")
  .option("--harness <harness>", "Which harness: claude | codex | all", "all")
  .option("--billing-mode <mode>", "Claude billing mode (transcripts don't record it): subscription | api", "subscription")
  .option("--dry-run", "Show what would be sent without sending anything")
  .option("--force", "Re-send buckets even if already present in Autumn (idempotency still dedups)")
  .option("--idempotency-salt <salt>", "Append a retry salt to backfill idempotency keys")
  .action(
    async (opts: {
      since?: string;
      until?: string;
      granularity?: string;
      harness?: string;
      billingMode?: string;
      dryRun?: boolean;
      force?: boolean;
      idempotencySalt?: string;
    }) => {
      const parseDate = (v: string | undefined, label: string): Date | undefined => {
        if (!v) return undefined;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${label} date: ${v}`);
        return d;
      };
      const granularity: Granularity = opts.granularity === "hourly" ? "hourly" : "daily";
      const harness: HarnessSelector =
        opts.harness === "claude" || opts.harness === "codex" ? opts.harness : "all";
      const billingMode: BillingMode = opts.billingMode === "api" ? "api" : "subscription";
      const since = parseDate(opts.since, "--since");
      const until = parseDate(opts.until, "--until");

      const auth = await ensureCustomer();
      const client = new AutumnClient(auth);
      console.log(
        `Reading local ${harness === "all" ? "Claude Code + Codex" : harness} history…${opts.dryRun ? " (dry run)" : ""}`
      );
      const res = await runBackfill(client, auth, {
        since,
        until,
        granularity,
        harness,
        billingMode,
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
        idempotencySalt: opts.idempotencySalt ?? process.env.SUMMER_BACKFILL_IDEMPOTENCY_SALT
      });
      printBackfill(res);
    }
  );

program
  .command("dash")
  .alias("dashboard")
  .description("Open the Summer usage dashboard in your browser.")
  .option("--port <port>", "Port for the dashboard server", "4321")
  .action(async (opts: { port?: string }) => {
    const port = Number(opts.port) || 4321;
    await serveDash(port);
    const url = `http://127.0.0.1:${port}`;
    console.log(`Summer dash running at ${url}`);
    await open(url).catch(() => undefined);
    await new Promise(() => undefined); // keep the server alive until Ctrl+C
  });

function printStartSummary(auth: SummerAuth, port: number, opts: { pid?: number | null; foreground?: boolean }) {
  const line = "─".repeat(56);
  const how = opts.foreground ? " (foreground)" : opts.pid ? ` (pid ${opts.pid})` : "";
  console.log(`\nSummer is running${how}.`);
  console.log(line);
  console.log(`Org / env:    ${orgEnv(auth)}`);
  console.log(`Developer:    ${auth.user?.email ?? auth.user?.id}`);
  console.log(`OTLP:         http://${LOCALHOST}:${port}/v1/logs`);
  console.log(`Dashboard:    ${auth.appUrl}`);
  console.log(line);
  console.log("Next: use Claude Code or Codex as usual — usage is tracked automatically.");
  console.log("View it with `summer report` or `summer dash`.");
  console.log();
}

async function importHistory(client: AutumnClient, auth: SummerAuth) {
  console.log("Importing local history…");
  const res = await runBackfill(client, auth, {
    harness: "all",
    granularity: "daily",
    billingMode: "subscription",
    dryRun: false
  });
  printBackfill(res);
}

/**
 * Offer to import existing local history. `--backfill`/`--skip-backfill` override the prompt.
 * Otherwise asks once on an interactive `start`; if the user declines (or accepts), we record
 * `backfillPromptedAt` so we don't nag on every run — `summer backfill` is always available.
 */
async function maybeOfferBackfill(
  client: AutumnClient,
  auth: SummerAuth,
  opts: { firstRun: boolean; backfill?: boolean; skipBackfill?: boolean }
) {
  if (opts.skipBackfill) return;
  if (opts.backfill) {
    await importHistory(client, auth);
    return;
  }
  if (!isInteractive()) return;

  const state = await readState();
  if (state.backfillPromptedAt) return; // already asked once — use `summer backfill` to import later.

  const doIt = await confirm("Import your existing Claude Code + Codex history now?", {
    default: opts.firstRun
  });
  await writeState({ ...(await readState()), backfillPromptedAt: new Date().toISOString() });

  if (!doIt) {
    console.log("Skipping import — run `summer backfill` anytime to import it. (Won't ask again.)");
    return;
  }
  await importHistory(client, auth);
}

program
  .command("start")
  .description("Set up (if needed) and start Summer — configures Claude Code and Codex.")
  .option("--debug", "Run in the foreground with debug logs.")
  .option("--yes", "Skip the org confirmation prompt.")
  .option("--switch-org", "Log in again to choose a different Autumn org before setup.")
  .option("--backfill", "Import existing history after setup without prompting.")
  .option("--skip-backfill", "Don't import existing history.")
  .action(
    async (options: {
      debug?: boolean;
      yes?: boolean;
      switchOrg?: boolean;
      backfill?: boolean;
      skipBackfill?: boolean;
    }) => {
      const debug = Boolean(options.debug || program.opts<{ debug?: boolean }>().debug);
      const { auth, firstRun } = await ensureSetup({ yes: options.yes, switchOrg: options.switchOrg });
      const autumn = new AutumnClient(auth);

      const runningDaemon = !debug ? await getRunningDaemon() : null;
      const port = runningDaemon?.port ?? (await resolveAvailableOtlpPort());
      await patchClaudeSettings(port);
      await patchCodexSettings(port);

      // Offer to import history before the daemon starts owning "now" (backfill reads local logs).
      await maybeOfferBackfill(autumn, auth, {
        firstRun,
        backfill: options.backfill,
        skipBackfill: options.skipBackfill
      });

      if (debug) {
        await writeState({
          ...(await readState()),
          daemon: { pid: process.pid, port, startedAt: new Date().toISOString() }
        });
        log.info({ action: "summer_started", foreground: true, customerId: auth.user?.id });
        printStartSummary(auth, port, { foreground: true });
        await serveForeground(port, { debug: true });
        return;
      }

      const pid = await startDaemon(port);
      printStartSummary(auth, port, { pid });
    }
  );

program.command("stop").description("Stop Summer and restore local harness settings.").action(async () => {
  await stopDaemon();
  await restoreClaudeSettings();
  await restoreCodexSettings();
  console.log("Summer stopped.");
});

program.command("status").description("Show Summer status.").action(async () => {
  const auth = await readAuth();
  const state = await readState();
  console.log(JSON.stringify({
    auth: auth
      ? {
          apiUrl: auth.apiUrl,
          appUrl: auth.appUrl,
          org: auth.org,
          user: auth.user,
          hasAccessToken: Boolean(auth.accessToken),
          hasRefreshToken: Boolean(auth.refreshToken)
        }
      : null,
    state,
    statePath: statePath()
  }, null, 2));
});

program
  .command("serve", { hidden: true })
  .option("--foreground", "Run in the foreground")
  .option("--debug", "Enable debug logs")
  .description("Run the local Summer daemon (internal — spawned by `start`).")
  .action(async (options: { debug?: boolean }) => {
    const debug = Boolean(options.debug || program.opts<{ debug?: boolean }>().debug);
    await serveForeground(getOtlpPort(), { debug });
  });

export async function runCli() {
  await program.parseAsync();
}
