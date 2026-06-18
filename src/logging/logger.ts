import { createLogger, initLogger, log } from "evlog";

let initialized = false;

export function summerDebugEnabled(explicit = false) {
  if (explicit) return true;
  if (process.env.SUMMER_DEBUG === "1") return true;
  return process.env.DEBUG?.split(",").some((item) => item.trim() === "summer") ?? false;
}

export function initSummerLogger(options: { debug?: boolean; service?: string } = {}) {
  if (initialized) return;
  initialized = true;

  const debug = summerDebugEnabled(options.debug);
  initLogger({
    env: {
      service: options.service ?? "summer",
      environment: process.env.NODE_ENV ?? "development"
    },
    minLevel: debug ? "debug" : "info",
    pretty: true,
    redact: true
  });
}

export function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }
  return { message: String(error) };
}

export { createLogger, log };
