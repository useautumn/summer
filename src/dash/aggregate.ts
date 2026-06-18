import type { AutumnClient } from "../clients/autumn.ts";

/** Property keys we surface as facets (filterable / groupable dimensions). */
export const FACET_KEYS = ["harness", "model", "billing_mode", "user_email", "source"] as const;

const USAGE_FEATURE = "usage_in_usd";
const DAY_MS = 86_400_000;
const PAGE = 1000;
const MAX_EVENTS = 20_000;

type RawEvent = {
  id: string;
  timestamp: number;
  value?: number;
  customer_id?: string;
  properties?: Record<string, unknown>;
};

/** Filters are a property-key → set-of-allowed-values map (OR within a key, AND across keys). */
export type Filters = Record<string, string[]>;

export type QueryResult = {
  rows: Array<Record<string, number | string>>;
  series: Array<{ key: string; total: number }>;
  facets: Record<string, string[]>;
  total: number;
  count: number;
  groupBy: string;
  days: number;
};

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function propValue(event: RawEvent, key: string): string {
  const value = (event.properties ?? {})[key];
  return value == null || value === "" ? "unknown" : String(value);
}

/** Apply property filters: an event must match at least one allowed value for every active key. */
function matchesFilters(event: RawEvent, filters: Filters): boolean {
  for (const [key, allowed] of Object.entries(filters)) {
    if (!allowed.length) continue;
    if (!allowed.includes(propValue(event, key))) return false;
  }
  return true;
}

/** Page through events.list (newest first), keeping events within [startMs, endMs]. */
async function fetchEvents(
  client: AutumnClient,
  opts: { customerId?: string; startMs: number; endMs: number }
): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  for (let offset = 0; offset < MAX_EVENTS; offset += PAGE) {
    const res = await client.listEvents({
      customerId: opts.customerId,
      featureId: USAGE_FEATURE,
      limit: PAGE,
      offset
    });
    const list = (res.list ?? []) as RawEvent[];
    let reachedCutoff = false;
    for (const event of list) {
      if (event.timestamp < opts.startMs) reachedCutoff = true;
      else if (event.timestamp <= opts.endMs) out.push(event);
    }
    if (list.length < PAGE || reachedCutoff) break;
  }
  return out;
}

/** Inclusive list of UTC day keys spanning [startMs, endMs]. */
function dayRange(startMs: number, endMs: number): string[] {
  const cursor = new Date(startMs);
  cursor.setUTCHours(0, 0, 0, 0);
  const days: string[] = [];
  for (let t = cursor.getTime(); t <= endMs && days.length < 400; t += DAY_MS) {
    days.push(dayKey(t));
  }
  return days.length ? days : [dayKey(endMs)];
}

/** Resolve an optional start/end window (epoch ms) to a sane [start, end]. */
function resolveWindow(start?: number, end?: number): { startMs: number; endMs: number } {
  const endMs = Number.isFinite(end) && end! > 0 ? end! : Date.now();
  const startMs = Number.isFinite(start) && start! > 0 ? start! : endMs - 30 * DAY_MS;
  return startMs <= endMs ? { startMs, endMs } : { startMs: endMs, endMs: startMs };
}

/** Distinct values per facet key, computed over the full (pre-filter) event set. */
function computeFacets(events: RawEvent[]): Record<string, string[]> {
  const facets: Record<string, Set<string>> = {};
  for (const key of FACET_KEYS) facets[key] = new Set();
  for (const event of events) {
    for (const key of FACET_KEYS) facets[key].add(propValue(event, key));
  }
  const out: Record<string, string[]> = {};
  for (const key of FACET_KEYS) out[key] = [...facets[key]].sort();
  return out;
}

/** Bucket usage_in_usd events by day and group by an event property — chart-ready rows. */
export async function queryUsage(
  client: AutumnClient,
  opts: { customerId?: string; groupBy?: string; start?: number; end?: number; filters?: Filters }
): Promise<QueryResult> {
  const groupBy = opts.groupBy && opts.groupBy !== "none" ? opts.groupBy : "none";
  const { startMs, endMs } = resolveWindow(opts.start, opts.end);
  const filters = opts.filters ?? {};
  const allEvents = await fetchEvents(client, { customerId: opts.customerId, startMs, endMs });
  const facets = computeFacets(allEvents);
  const events = allEvents.filter((e) => matchesFilters(e, filters));

  const byDay = new Map<string, Map<string, number>>();
  const groupTotals = new Map<string, number>();
  let total = 0;
  for (const event of events) {
    const day = dayKey(event.timestamp);
    const group = groupBy === "none" ? "usage" : propValue(event, groupBy);
    const value = Number(event.value) || 0;
    if (!byDay.has(day)) byDay.set(day, new Map());
    const dayMap = byDay.get(day)!;
    dayMap.set(group, (dayMap.get(group) ?? 0) + value);
    groupTotals.set(group, (groupTotals.get(group) ?? 0) + value);
    total += value;
  }

  const series = [...groupTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, groupTotal]) => ({ key, total: groupTotal }));

  const days = dayRange(startMs, endMs);
  const rows: Array<Record<string, number | string>> = days.map((day) => {
    const dayMap = byDay.get(day);
    const row: Record<string, number | string> = { period: day };
    for (const s of series) row[s.key] = dayMap?.get(s.key) ?? 0;
    return row;
  });

  return { rows, series, facets, total, count: events.length, groupBy, days: days.length };
}

export type EventRow = {
  id: string;
  timestamp: number;
  value: number;
  properties: Record<string, unknown>;
};

/** Recent events (newest first) for the events table, with property filters applied. */
export async function queryEvents(
  client: AutumnClient,
  opts: { customerId?: string; start?: number; end?: number; filters?: Filters; limit?: number }
): Promise<{ list: EventRow[] }> {
  const { startMs, endMs } = resolveWindow(opts.start, opts.end);
  const filters = opts.filters ?? {};
  const limit = Math.max(1, Math.min(5000, opts.limit ?? 1000));
  const events = await fetchEvents(client, { customerId: opts.customerId, startMs, endMs });
  const list = events
    .filter((e) => matchesFilters(e, filters))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      timestamp: e.timestamp,
      value: Number(e.value) || 0,
      properties: e.properties ?? {}
    }));
  return { list };
}
