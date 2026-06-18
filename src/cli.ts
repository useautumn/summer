#!/usr/bin/env bun
import { runCli } from "./cli/program.ts";
import { initSummerLogger } from "./logging/logger.ts";

initSummerLogger({ debug: process.argv.includes("--debug") });
await runCli();
