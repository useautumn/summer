import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LOCALHOST } from "../config/constants.ts";
import { summerHome } from "../config/storage.ts";
import { log, serializeError } from "../logging/logger.ts";

const exec = promisify(execFile);

const LABEL = "com.useautumn.summer";
const logPath = () => join(summerHome(), "daemon.log");
const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const systemdPath = () => join(homedir(), ".config", "systemd", "user", "summer.service");

export type ServiceKind = "launchd" | "systemd";

/** The autostart backend for this platform, or null if unsupported. */
export function serviceKind(): ServiceKind | null {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") return "systemd";
  return null;
}

/** [bun, cli.ts] — the same runtime + entry the detached daemon uses. */
function daemonArgv(): { bin: string; cli: string } {
  return { bin: process.execPath, cli: fileURLToPath(new URL("../cli.ts", import.meta.url)) };
}

/**
 * Env the boot service must carry: the OTLP port + (in dev) the Autumn URL overrides AND `SUMMER_DIR`.
 * `SUMMER_DIR` is critical — it selects the auth/state home dir. Omitting it made a dev install's
 * autostart daemon read prod auth (~/.summer) while talking to the dev API → 401 on every track.
 */
function serviceEnv(port: number): Record<string, string> {
  const env: Record<string, string> = { SUMMER_OTLP_PORT: String(port) };
  for (const key of ["SUMMER_DIR", "SUMMER_AUTUMN_API_URL", "SUMMER_AUTUMN_APP_URL"]) {
    if (process.env[key]) env[key] = process.env[key] as string;
  }
  return env;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function launchdPlist(port: number): string {
  const { bin, cli } = daemonArgv();
  const args = [bin, cli, "serve", "--foreground"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const env = {
    ...serviceEnv(port),
    PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  };
  const envEntries = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath())}</string>
</dict>
</plist>
`;
}

function systemdUnit(port: number): string {
  const { bin, cli } = daemonArgv();
  const envLines = Object.entries(serviceEnv(port))
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  return `[Unit]
Description=Summer — local AI coding usage meter
After=default.target

[Service]
Type=simple
ExecStart=${bin} ${cli} serve --foreground
${envLines}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** launchctl/systemctl run; never throws — returns false on failure. */
async function tryExec(file: string, args: string[]): Promise<boolean> {
  try {
    await exec(file, args);
    return true;
  } catch (error) {
    log.debug({ action: "service_exec_failed", file, args, error: serializeError(error) });
    return false;
  }
}

/** Install + load/enable the boot service so the daemon runs now and on every login. */
export async function installService(port: number): Promise<ServiceKind> {
  const kind = serviceKind();
  if (!kind) throw new Error(`Autostart isn't supported on ${process.platform} yet.`);
  await mkdir(summerHome(), { recursive: true });

  if (kind === "launchd") {
    const path = plistPath();
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(path, launchdPlist(port), { mode: 0o644 });
    await tryExec("launchctl", ["unload", path]); // ignore "not loaded"
    if (!(await tryExec("launchctl", ["load", "-w", path]))) {
      throw new Error("launchctl load failed — could not register the autostart service.");
    }
    return kind;
  }

  const path = systemdPath();
  await mkdir(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  await writeFile(path, systemdUnit(port), { mode: 0o644 });
  await tryExec("systemctl", ["--user", "daemon-reload"]);
  // Best-effort: let the user service survive logout / run at boot.
  await tryExec("loginctl", ["enable-linger", process.env.USER ?? ""]);
  if (!(await tryExec("systemctl", ["--user", "enable", "--now", "summer.service"]))) {
    throw new Error("systemctl --user enable failed — could not register the autostart service.");
  }
  return kind;
}

/** Stop + remove the boot service. Safe to call when nothing is installed. */
export async function uninstallService(): Promise<void> {
  const kind = serviceKind();
  if (kind === "launchd") {
    const path = plistPath();
    await tryExec("launchctl", ["unload", "-w", path]);
    await rm(path, { force: true });
  } else if (kind === "systemd") {
    await tryExec("systemctl", ["--user", "disable", "--now", "summer.service"]);
    await rm(systemdPath(), { force: true });
    await tryExec("systemctl", ["--user", "daemon-reload"]);
  }
}

/** Is OUR daemon answering on its health endpoint? Verifies the `service: "summer"` marker so we
 * don't mistake another service's /health (e.g. an openlogs collector on the same port) for ours. */
async function daemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOCALHOST}:${port}/health`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { service?: string } | null;
    return body?.service === "summer";
  } catch {
    return false;
  }
}

export async function serviceStatus(port: number): Promise<{
  kind: ServiceKind | null;
  installed: boolean;
  running: boolean;
}> {
  const kind = serviceKind();
  if (!kind) return { kind: null, installed: false, running: false };
  let installed = false;
  if (kind === "launchd") {
    installed = await tryExec("launchctl", ["list", LABEL]);
  } else {
    installed = await tryExec("systemctl", ["--user", "is-enabled", "summer.service"]);
  }
  return { kind, installed, running: await daemonHealthy(port) };
}
