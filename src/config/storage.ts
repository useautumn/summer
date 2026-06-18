import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SUMMER_DIR } from "./constants.ts";
import type { SummerAuth, SummerState } from "../domain/types.ts";

export const summerHome = () => join(homedir(), SUMMER_DIR);
export const authPath = () => join(summerHome(), "auth.json");
export const statePath = () => join(summerHome(), "state.json");
export const claudeSnapshotPath = () => join(summerHome(), "claude-settings.snapshot.json");
export const codexSnapshotPath = () => join(summerHome(), "codex-config.snapshot.toml");

async function ensureDir(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(path: string, value: unknown) {
  await ensureDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export const readAuth = () => readJson<SummerAuth>(authPath());
export const writeAuth = (auth: SummerAuth) => writeJson(authPath(), auth);
export const clearAuth = () => rm(authPath(), { force: true });

export const readState = async () => (await readJson<SummerState>(statePath())) ?? {};
export const writeState = (state: SummerState) => writeJson(statePath(), state);
