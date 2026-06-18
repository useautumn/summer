import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getOtlpPort, LOCALHOST, OTLP_LOGS_PATH } from "../../config/constants.ts";
import { codexSnapshotPath, readState, writeState } from "../../config/storage.ts";
import { log } from "../../logging/logger.ts";

const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");
const SUMMER_START = "# summer:otel:start";
const SUMMER_END = "# summer:otel:end";
// Match our current block AND any legacy (pre-rename) managed block, so an upgrade/rename
// replaces it instead of tripping the "[otel] already exists" guard or poisoning the snapshot.
const MANAGED_BLOCK_RE = /# (?:summer|spring):otel:start[\s\S]*?# (?:summer|spring):otel:end\n?/;

/** Remove any Summer/legacy-managed [otel] block so a snapshot reflects the unpatched config. */
function stripManagedBlock(config: string) {
  return config.replace(MANAGED_BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

async function readTextFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function managedBlock(port: number) {
  return [
    SUMMER_START,
    "[otel]",
    'environment = "local"',
    "log_user_prompt = false",
    `exporter = { otlp-http = { endpoint = "http://${LOCALHOST}:${port}${OTLP_LOGS_PATH}", protocol = "json" } }`,
    SUMMER_END
  ].join("\n");
}

function replaceManagedBlock(config: string, port: number) {
  const block = managedBlock(port);
  if (MANAGED_BLOCK_RE.test(config)) return `${config.replace(MANAGED_BLOCK_RE, block).trimEnd()}\n`;

  if (/^\[otel\]\s*$/m.test(config)) {
    throw new Error(
      `Codex config already has an [otel] section. Remove it or let Summer own it before running summer start.`
    );
  }

  return `${config.trimEnd()}\n\n${block}\n`;
}

export async function patchCodexSettings(port = getOtlpPort()) {
  const config = await readTextFile(CODEX_CONFIG);
  const state = await readState();
  if (!state.codex?.patched) {
    await mkdir(dirname(codexSnapshotPath()), { recursive: true });
    const clean = stripManagedBlock(config);
    await writeFile(codexSnapshotPath(), clean ? `${clean}\n` : "", { mode: 0o600 });
    log.info({ action: "codex_config_snapshot_created", path: codexSnapshotPath() });
  }

  await mkdir(dirname(CODEX_CONFIG), { recursive: true });
  await writeFile(CODEX_CONFIG, replaceManagedBlock(config, port), { mode: 0o600 });
  await writeState({
    ...state,
    codex: {
      patched: true,
      snapshotPath: codexSnapshotPath(),
      patchedAt: new Date().toISOString()
    }
  });
  log.info({
    action: "codex_config_patched",
    configPath: CODEX_CONFIG,
    otlpLogsEndpoint: `http://${LOCALHOST}:${port}${OTLP_LOGS_PATH}`
  });
}

export async function restoreCodexSettings() {
  const state = await readState();
  const snapshot = state.codex?.snapshotPath;
  if (!snapshot) return;
  const original = await readFile(snapshot, "utf8");
  await writeFile(CODEX_CONFIG, original, { mode: 0o600 });
  await writeState({
    ...state,
    codex: { patched: false, snapshotPath: snapshot }
  });
  log.info({ action: "codex_config_restored", configPath: CODEX_CONFIG });
}
