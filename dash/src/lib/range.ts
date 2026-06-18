import type { Range } from "@/lib/api";

const DAY_MS = 86_400_000;

export const RANGE_PRESETS = [
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" }
] as const;

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

/** A preset window of the last `days` days, inclusive of today (N day buckets). */
export const presetRange = (days: number): Range => {
  const end = endOfUtcDay(Date.now());
  const start = startOfUtcDay(end - (days - 1) * DAY_MS);
  return { start, end };
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
export const matchedPreset = (r: Range): number | null => {
  for (const p of RANGE_PRESETS) {
    const pr = presetRange(p.days);
    if (Math.abs(pr.start - r.start) < DAY_MS && Math.abs(pr.end - r.end) < DAY_MS) return p.days;
  }
  return null;
};
