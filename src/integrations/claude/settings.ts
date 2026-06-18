import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOtlpPort, LOCALHOST, OTLP_LOGS_PATH } from "../../config/constants.ts";
import { claudeSnapshotPath, readState, writeState } from "../../config/storage.ts";
import { log } from "../../logging/logger.ts";

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const SUMMER_HOOK_COMMAND = "summer hook claude-user-prompt";

// The env keys Summer injects. Stripped when snapshotting so an already-patched settings.json
// (e.g. after a rename/upgrade with stale state) can't poison the "pristine" snapshot.
const MANAGED_ENV_KEYS = [
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_RAW_API_BODIES"
];

type JsonObject = Record<string, unknown>;

/** A copy of settings with Summer-managed env keys + hook removed (for an unpatched snapshot). */
function unpatchedSnapshot(settings: JsonObject): JsonObject {
  const snapshot = structuredClone(settings);
  const env = snapshot.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const key of MANAGED_ENV_KEYS) delete (env as JsonObject)[key];
    if (Object.keys(env).length === 0) delete snapshot.env;
  }
  removeLegacySummerHook(snapshot);
  return snapshot;
}

async function readJsonFile(path: string): Promise<JsonObject> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function envObject(settings: JsonObject) {
  const env = settings.env;
  if (env && typeof env === "object" && !Array.isArray(env)) return env as JsonObject;
  const next: JsonObject = {};
  settings.env = next;
  return next;
}

export async function patchClaudeSettings(port = getOtlpPort()) {
  const settings = await readJsonFile(CLAUDE_SETTINGS);
  const state = await readState();
  if (!state.claude?.patched) {
    await writeFile(claudeSnapshotPath(), `${JSON.stringify(unpatchedSnapshot(settings), null, 2)}\n`, {
      mode: 0o600
    });
    log.info({ action: "claude_settings_snapshot_created", path: claudeSnapshotPath() });
  }

  const env = envObject(settings);
  env.CLAUDE_CODE_ENABLE_TELEMETRY = "1";
  env.OTEL_LOGS_EXPORTER = "otlp";
  env.OTEL_METRICS_EXPORTER = "none";
  env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/json";
  env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `http://${LOCALHOST}:${port}${OTLP_LOGS_PATH}`;
  env.OTEL_LOG_USER_PROMPTS = "0";
  env.OTEL_LOG_TOOL_DETAILS = "0";
  env.OTEL_LOG_RAW_API_BODIES = "0";

  removeLegacySummerHook(settings);

  await writeFile(CLAUDE_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600
  });
  await writeState({
    ...state,
    claude: {
      patched: true,
      snapshotPath: claudeSnapshotPath(),
      patchedAt: new Date().toISOString()
    }
  });
  log.info({
    action: "claude_settings_patched",
    settingsPath: CLAUDE_SETTINGS,
    otlpLogsEndpoint: env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  });
}

export async function restoreClaudeSettings() {
  const state = await readState();
  const snapshot = state.claude?.snapshotPath;
  if (!snapshot) return;
  const original = await readFile(snapshot, "utf8");
  await writeFile(CLAUDE_SETTINGS, original, { mode: 0o600 });
  await writeState({
    ...state,
    claude: { patched: false, snapshotPath: snapshot }
  });
  log.info({ action: "claude_settings_restored", settingsPath: CLAUDE_SETTINGS });
}

function removeLegacySummerHook(settings: JsonObject) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;

  const hooksObject = hooks as JsonObject;
  const userPromptSubmit = hooksObject.UserPromptSubmit;
  if (!Array.isArray(userPromptSubmit)) return;

  const cleaned = userPromptSubmit.filter((item) => {
    return !(
      item &&
      typeof item === "object" &&
      "command" in item &&
      (item as { command?: unknown }).command === SUMMER_HOOK_COMMAND
    );
  });

  if (cleaned.length > 0) {
    hooksObject.UserPromptSubmit = cleaned;
  } else {
    delete hooksObject.UserPromptSubmit;
  }
}
