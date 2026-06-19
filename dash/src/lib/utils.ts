import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)"
];

export const usd = (n: number | undefined) =>
  "$" +
  (Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

export const compactNumber = (n: number) =>
  new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Human label for a raw property value (e.g. "claude_code" -> "Claude Code"). */
export function label(value: string): string {
  if (!value) return "—";
  if (value === "unknown") return "Unknown";
  if (value === "claude_code") return "Claude Code";
  if (value === "codex") return "Codex";
  if (value === "api") return "API";
  if (value === "subscription") return "Subscription";
  if (value.length > 22 && /^[a-f0-9-]+$/i.test(value)) return `${value.slice(0, 8)}…`;
  return value;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/** Absolute local date + time, e.g. "12 June 14:30". */
export function dateTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000]
];
export function relativeTime(ms: number): string {
  const diff = ms - Date.now();
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size || unit === "minute") return rtf.format(Math.round(diff / size), unit);
  }
  return "just now";
}
