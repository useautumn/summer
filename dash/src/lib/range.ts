import type { Range } from "@/lib/api";

const DAY_MS = 86_400_000;

export type RangePreset = { key: string; label: string; weeks?: number; months?: number };

export const RANGE_PRESETS: RangePreset[] = [
  { key: "1w", label: "1w", weeks: 1 },
  { key: "1m", label: "1m", months: 1 },
  { key: "3m", label: "3m", months: 3 }
];
export const DEFAULT_PRESET = RANGE_PRESETS[1]; // 1 month

// The server buckets by UTC day, so keep the date inputs on UTC boundaries too
// (avoids off-by-one day labels in non-UTC timezones).
const startOfUtcDay = (ms: number) => {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
};
const endOfUtcDay = (ms: number) => {
  const d = new Date(ms);
  d.setUTCHours(23, 59, 59, 999);
  return d.getTime();
};

/** A preset window ending today, going back 1 week / 1 or 3 calendar months (calendar-accurate, so
 * "1m" from 19 Jun is 19 May — not "30 days" which lands a day off and confuses people). */
export const presetRange = (p: RangePreset): Range => {
  const end = endOfUtcDay(Date.now());
  const d = new Date(end);
  if (p.months) d.setUTCMonth(d.getUTCMonth() - p.months);
  if (p.weeks) d.setUTCDate(d.getUTCDate() - p.weeks * 7);
  return { start: startOfUtcDay(d.getTime()), end };
};

/** `yyyy-mm-dd` for an `<input type="date">`, in UTC. */
export const toDateInput = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/** Human label like "12 June 2026". Returns "Now" for an end that lands on today. */
export const formatRangeLabel = (ms: number, opts?: { isEnd?: boolean }): string => {
  if (opts?.isEnd && toDateInput(ms) === toDateInput(Date.now())) return "Now";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS_FULL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
export const fromDateInputStart = (s: string) => Date.parse(`${s}T00:00:00.000Z`);
export const fromDateInputEnd = (s: string) => Date.parse(`${s}T23:59:59.999Z`);

export const rangeDays = (r: Range) => Math.max(1, Math.round((r.end - r.start) / DAY_MS));

/** Which preset (if any) the current range corresponds to, for highlighting. */
export const matchedPreset = (r: Range): string | null => {
  for (const p of RANGE_PRESETS) {
    const pr = presetRange(p);
    if (Math.abs(pr.start - r.start) < DAY_MS && Math.abs(pr.end - r.end) < DAY_MS) return p.key;
  }
  return null;
};
