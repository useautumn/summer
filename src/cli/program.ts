import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getOAuthDebugConfig, login, requireAuth } from "../auth/oauth.ts";
import { AutumnClient } from "../clients/autumn.ts";
import { LOCALHOST, OTLP_PORT, SUMMER_FEATURES, getOtlpPort } from "../config/constants.ts";
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
import { processDroidSessions } from "../integrations/droid/sessions.ts";
import { choose, confirm, isInteractive } from "./prompts.ts";
import { bold, dim } from "./style.ts";
import {
  installService,
  serviceKind,
  serviceStatus,
  type ServiceKind,
  uninstallService
} from "./service.ts";
import { log, serializeError } from "../logging/logger.ts";

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
    const localConfirmed = Boolean(state.setup?.orgId && state.setup.orgId === auth.org?.id);
    const client = new AutumnClient(auth);

    // The org is already set up if Autumn has Summer's features — skip the prompt even on a
    // fresh machine with no local marker. (`firstRun` still tracks the local marker so we can
    // offer to backfill this machine's history.)
    let orgHasFeatures = false;
    if (!localConfirmed) {
      try {
        const have = new Set((await client.listFeatures()).list.map((f) => f.id));
        orgHasFeatures = SUMMER_FEATURES.every((f) => have.has(f.id));
      } catch (error) {
        log.debug({ action: "feature_check_failed", error: serializeError(error) });
      }
    }
    const confirmed = localConfirmed || orgHasFeatures;

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
    if (!localConfirmed) {
      await writeState({
        ...(await readState()),
        setup: { orgId: auth.org?.id ?? "", confirmedAt: new Date().toISOString() }
      });
    }
    // First run on THIS machine (no local marker) — lets the caller offer a backfill even
    // when the org was already set up elsewhere.
    return { auth, firstRun: !localConfirmed };
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

/**
 * True only if a SUMMER daemon is healthy on `port`. We verify the `service: "summer"` marker in the
 * /health body — NOT just `response.ok` — so we never mistake another service's /health for ours
 * (e.g. an openlogs collector on 4318 also returns `{ok:true}`, which would otherwise make us reuse
 * its port and patch Claude Code's telemetry into a black hole).
 */
async function summerDaemonOnPort(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${LOCALHOST}:${port}/health`);
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { service?: string } | null;
    return body?.service === "summer";
  } catch {
    return false;
  }
}

async function resolveAvailableOtlpPort() {
  const requested = getOtlpPort();
  if (await canBindPort(requested)) return requested;

  // Busy — but if it's OUR daemon already on this port, reuse it (idempotent `start`).
  if (await summerDaemonOnPort(requested)) return requested;

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
  // The autostart service (launchd/systemd) owns the daemon, so its pid isn't tracked here;
  // detect a running daemon by health-checking the known port rather than relying on a pid.
  const port = state.daemon?.port ?? state.service?.port;
  if (!port) return null;

  const pid = state.daemon?.pid ?? 0;
  if (!(await summerDaemonOnPort(port))) return null;
  return { pid, port };
}

async function waitForDaemon(port: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await summerDaemonOnPort(port)) return;
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

  // Per-day rollup (UTC) so you can eyeball the shape before/after sending. One column per harness
  // present in the result, so new harnesses (opencode, …) show up without hardcoding.
  const harnesses = [...new Set(res.buckets.map((b) => b.harness))].sort();
  const byDay = new Map<string, Record<string, number>>();
  for (const b of res.buckets) {
    const day = b.label.slice(0, 10);
    const row = byDay.get(day) ?? {};
    row[b.harness] = (row[b.harness] ?? 0) + b.inputTokens + b.outputTokens;
    byDay.set(day, row);
  }
  if (byDay.size > 0) {
    const header = harnesses.map((h) => `${h} tok`.padStart(16)).join("");
    console.log(`${"Day".padEnd(12)}${header}`);
    for (const day of [...byDay.keys()].sort()) {
      const r = byDay.get(day)!;
      const cols = harnesses.map((h) => (r[h] ?? 0).toLocaleString().padStart(16)).join("");
      console.log(`${day.padEnd(12)}${cols}`);
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
    const wouldSend = res.buckets.length - res.skipped;
    console.log(
      `${wouldSend} bucket(s) would be sent` +
        (res.skipped > 0 ? `, ${res.skipped} skipped (already imported / live-covered)` : "") +
        ". Re-run without --dry-run to import."
    );
  } else {
    // Backfill sends async, so Autumn prices the events shortly — `value` isn't in the response.
    const usdPart = res.usd > 0 ? `   Total: $${res.usd.toFixed(4)}` : "   (values pricing in Autumn…)";
    console.log(`Sent: ${res.sent}   Skipped (already imported): ${res.skipped}${usdPart}`);
    if (res.failed > 0) {
      console.log(`Failed: ${res.failed} bucket(s) — re-run \`summer backfill\` to retry (idempotent).`);
    }
  }
  console.log();
}

program
  .command("backfill")
  .description("Import historical Claude Code, Codex, OpenCode + Pi usage into Autumn (backdated, aggregated).")
  .option("--since <date>", "Only backfill usage on/after this date (e.g. 2026-05-01)")
  .option("--until <date>", "Only backfill usage before this date (default: auto-cap at first live event)")
  .option("--granularity <granularity>", "Aggregation bucket: daily | hourly", "daily")
  .option("--harness <harness>", "Which harness: claude | codex | opencode | pi | all", "all")
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
      if (opts.harness === "droid") {
        console.error("Droid only supports live tracking. Use `summer droid --dry-run` to preview new usage.");
        process.exitCode = 1;
        return;
      }
      const parseDate = (v: string | undefined, label: string): Date | undefined => {
        if (!v) return undefined;
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${label} date: ${v}`);
        return d;
      };
      const granularity: Granularity = opts.granularity === "hourly" ? "hourly" : "daily";
      const harness: HarnessSelector =
        opts.harness === "claude" || opts.harness === "codex" || opts.harness === "opencode" || opts.harness === "pi"
          ? opts.harness
          : "all";
      const billingMode: BillingMode = opts.billingMode === "api" ? "api" : "subscription";
      const since = parseDate(opts.since, "--since");
      const until = parseDate(opts.until, "--until");

      const auth = await ensureCustomer();
      const client = new AutumnClient(auth);
      console.log(
        `Reading local ${harness === "all" ? "Claude Code, Codex, OpenCode + Pi" : harness} history…${opts.dryRun ? " (dry run)" : ""}`
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
  .command("droid")
  .description("Poll Factory Droid sessions once and track new usage.")
  .option("--dry-run", "Show what the poll would send without sending anything")
  .action(async (opts: { dryRun?: boolean }) => {
    const auth = await readAuth();
    if (!auth) {
      console.log('Not logged in — run "summer login" first.');
      return;
    }
    const dryRun = Boolean(opts.dryRun);
    const deltas = await processDroidSessions(new AutumnClient(auth), auth, { dryRun });
    const line = "─".repeat(60);
    console.log(`\nSummer — Droid${dryRun ? " (DRY RUN — nothing sent)" : ""}`);
    console.log(line);
    if (deltas.length === 0) {
      console.log("Nothing new — all recent Droid sessions are already tracked.");
    } else {
      for (const d of deltas) {
        const t = d.tokens;
        console.log(`${d.at.toISOString()}  ${d.provider}/${d.model}  [${d.billingMode}]  ${dim(d.sessionId)}`);
        console.log(
          `  in ${t.input.toLocaleString()}  out ${t.output.toLocaleString()}  cache-read ${t.cacheRead.toLocaleString()}  cache-write ${t.cacheWrite.toLocaleString()}  reasoning ${t.reasoning.toLocaleString()}`
        );
      }
      console.log(line);
      console.log(
        dryRun
          ? `${deltas.length} session delta(s) would be sent. Re-run without --dry-run to track them.`
          : `Tracked ${deltas.length} session delta(s).`
      );
    }
    console.log();
  });

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

function printStartSummary(
  auth: SummerAuth,
  port: number,
  opts: { pid?: number | null; foreground?: boolean; autostart?: ServiceKind | null }
) {
  const line = "─".repeat(56);
  const how = opts.foreground ? " (foreground)" : opts.pid ? ` (pid ${opts.pid})` : "";
  console.log(`\nSummer is running${how}.`);
  console.log(line);
  console.log(`Org / env:    ${orgEnv(auth)}`);
  console.log(`Developer:    ${auth.user?.email ?? auth.user?.id}`);
  console.log(`OTLP:         http://${LOCALHOST}:${port}/v1/logs`);
  console.log(`Dashboard:    ${auth.appUrl}`);
  console.log(
    `Autostart:    ${opts.autostart ? `on (${opts.autostart}) — restarts on login/reboot` : "off"}`
  );
  console.log(line);
  console.log("Next: use your supported coding agents as usual — usage is tracked automatically.");
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

  const doIt = await confirm("Import your existing Claude Code, Codex, OpenCode + Pi history now?", {
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
  .description("Set up (if needed) and start Summer — tracks Claude Code, Codex, OpenCode, Droid + Pi.")
  .option("--debug", "Run in the foreground with debug logs.")
  .option("--yes", "Skip the org confirmation prompt.")
  .option("--switch-org", "Log in again to choose a different Autumn org before setup.")
  .option("--backfill", "Import existing history after setup without prompting.")
  .option("--skip-backfill", "Don't import existing history.")
  .option("--no-service", "Don't install the on-boot autostart service.")
  .action(
    async (options: {
      debug?: boolean;
      yes?: boolean;
      switchOrg?: boolean;
      backfill?: boolean;
      skipBackfill?: boolean;
      service?: boolean;
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

      // Prefer the OS autostart service so Summer survives reboots; the service (launchd/
      // systemd) owns the daemon, so we don't also spawn a detached one. Fall back to a
      // detached process when autostart is unsupported or opted out.
      const useService = options.service !== false && serviceKind() !== null;
      if (useService) {
        // Idempotent: if the autostart service is already installed and healthy, leave it be.
        const status = await serviceStatus(port);
        if (status.installed && status.running) {
          await writeState({
            ...(await readState()),
            service: { kind: status.kind!, port, installedAt: new Date().toISOString() },
            daemon: { pid: 0, port, startedAt: new Date().toISOString() }
          });
          printStartSummary(auth, port, { autostart: status.kind });
          return;
        }
        await stopDaemon().catch(() => undefined); // hand the port to the service
        let kind: ServiceKind | null = null;
        try {
          kind = await installService(port);
          await waitForDaemon(port);
          await writeState({
            ...(await readState()),
            service: { kind, port, installedAt: new Date().toISOString() },
            daemon: { pid: 0, port, startedAt: new Date().toISOString() }
          });
        } catch (error) {
          log.warn({ action: "service_install_failed", error: serializeError(error) });
          console.log("Couldn't install the autostart service — starting in the background instead.");
          kind = null;
        }
        if (kind) {
          printStartSummary(auth, port, { autostart: kind });
          return;
        }
      }

      const pid = await startDaemon(port);
      printStartSummary(auth, port, { pid, autostart: null });
    }
  );

program.command("stop").description("Stop Summer and restore local harness settings.").action(async () => {
  await uninstallService().catch(() => undefined);
  await stopDaemon();
  await writeState({ ...(await readState()), service: undefined });
  await restoreClaudeSettings();
  await restoreCodexSettings();
  console.log("Summer stopped.");
});

const service = program
  .command("service")
  .description("Manage the on-boot autostart service (launchd / systemd).");

service
  .command("install")
  .description("Install the autostart service so Summer runs on login/reboot.")
  .action(async () => {
    if (!serviceKind()) {
      console.log(`Autostart isn't supported on ${process.platform} yet.`);
      return;
    }
    await ensureCustomer();
    const state = await readState();
    const port = state.service?.port ?? state.daemon?.port ?? (await resolveAvailableOtlpPort());
    await patchClaudeSettings(port);
    await patchCodexSettings(port);
    await stopDaemon().catch(() => undefined);
    const kind = await installService(port);
    await waitForDaemon(port);
    await writeState({
      ...(await readState()),
      service: { kind, port, installedAt: new Date().toISOString() },
      daemon: { pid: 0, port, startedAt: new Date().toISOString() }
    });
    console.log(`Autostart enabled (${kind}) — Summer will run on login/reboot.`);
  });

service
  .command("uninstall")
  .description("Remove the autostart service.")
  .action(async () => {
    await uninstallService();
    await writeState({ ...(await readState()), service: undefined });
    console.log("Autostart disabled.");
  });

service
  .command("status")
  .description("Show autostart service status.")
  .action(async () => {
    const state = await readState();
    const port = state.service?.port ?? state.daemon?.port ?? getOtlpPort();
    const status = await serviceStatus(port);
    if (!status.kind) {
      console.log(`Autostart: unsupported on ${process.platform}`);
      return;
    }
    console.log(`Autostart: ${status.installed ? "installed" : "not installed"} (${status.kind})`);
    console.log(`Daemon:    ${status.running ? `running on :${port}` : "not running"}`);
  });

program
  .command("status")
  .description("Show whether the Summer daemon is running.")
  .option("--json", "Print full auth + state as JSON.")
  .action(async (opts: { json?: boolean }) => {
    if (opts.json) {
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
      return;
    }

    const daemon = await getRunningDaemon();
    if (daemon) {
      console.log(`Summer daemon: running (pid ${daemon.pid}, port ${daemon.port})`);
    } else {
      console.log("Summer daemon: not running — start it with `summer start`.");
    }
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
