import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BarChart3, ExternalLink, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { ChartLegend, type ChartLegendEntry } from "@/components/ChartLegend";
import { ChartSkeleton } from "@/components/ChartSkeleton";
import { EventsTable } from "@/components/EventsTable";
import { FilterCard } from "@/components/FilterCard";
import { GroupByCard } from "@/components/GroupByCard";
import { DateInput } from "@/components/DateInput";
import { UsageChart } from "@/components/UsageChart";
import { UserCard } from "@/components/UserCard";
import { UserList } from "@/components/UserList";
import { api, type Customer, type Filters, type Range } from "@/lib/api";
import {
  DEFAULT_PLOT_INSETS,
  getCachedPlotInsets,
  niceCeil,
  type PlotInsets,
  plotInsetsEqual,
  setCachedPlotInsets
} from "@/lib/chartGeometry";
import { formatRangeLabel, matchedPreset, presetRange, RANGE_PRESETS, rangeDays } from "@/lib/range";
import { CHART_COLORS, cn, label, usd } from "@/lib/utils";

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function App() {
  const [groupBy, setGroupBy] = useState("harness");
  const [range, setRange] = useState<Range>(() => presetRange(30));
  const [selected, setSelected] = useState<Customer | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const debouncedSearch = useDebounced(search, 250);
  const customerId = selected?.id ?? "";

  const reduceMotion = useReducedMotion();
  const [plotInsets, setPlotInsets] = useState<PlotInsets>(
    () => getCachedPlotInsets() ?? DEFAULT_PLOT_INSETS
  );
  const handlePlotGeometry = useCallback((insets: PlotInsets) => {
    setCachedPlotInsets(insets);
    setPlotInsets((prev) => (plotInsetsEqual(prev, insets) ? prev : insets));
  }, []);

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const customers = useQuery({
    queryKey: ["customers", debouncedSearch],
    queryFn: () => api.customers(debouncedSearch || undefined),
    placeholderData: keepPreviousData
  });
  const usage = useQuery({
    queryKey: ["query", groupBy, range, customerId, filters],
    queryFn: () => api.query({ groupBy, range, customerId: customerId || undefined, filters }),
    placeholderData: keepPreviousData
  });
  // Facets are filter-independent, so keep them on their own key (no flash on filter toggle).
  const byUser = useQuery({
    queryKey: ["byUser", range],
    queryFn: () => api.query({ groupBy: "user_email", range }),
    placeholderData: keepPreviousData
  });
  const events = useQuery({
    queryKey: ["events", customerId, range, filters],
    queryFn: () => api.events({ customerId: customerId || undefined, range, filters, limit: 2000 }),
    placeholderData: keepPreviousData
  });

  const usageByEmail: Record<string, number> = {};
  for (const s of byUser.data?.series ?? []) if (s.key !== "unknown") usageByEmail[s.key] = s.total;

  const facets = byUser.data?.facets ?? usage.data?.facets ?? {};
  const series = usage.data?.series ?? [];

  // Stable y-domain + per-bar target fractions so the skeleton settles into place.
  const { domainMax, barFractions } = useMemo(() => {
    const rows = usage.data?.rows;
    if (!rows || rows.length === 0 || series.length === 0) {
      return { domainMax: undefined as number | undefined, barFractions: null as number[] | null };
    }
    const totals = rows.map((row) =>
      series.reduce((sum, s) => sum + Number(row[s.key] ?? 0), 0)
    );
    const max = niceCeil(Math.max(...totals, 1));
    return { domainMax: max, barFractions: totals.map((t) => t / max) };
  }, [usage.data?.rows, series]);

  const legendEntries: ChartLegendEntry[] = useMemo(
    () =>
      series
        .filter((s) => s.total > 0)
        .map((s, i) => ({
          key: s.key,
          label: label(s.key),
          color: CHART_COLORS[i % CHART_COLORS.length],
          value: s.total,
          title: `${label(s.key)}: ${usd(s.total)}`
        })),
    [series]
  );

  const hasChart = !usage.isLoading && !!usage.data && (usage.data.total ?? 0) > 0;
  const isEmpty = !usage.isLoading && !hasChart;
  const revealDelay = reduceMotion ? 0 : 0.85;
  const activePreset = matchedPreset(range);
  const barCount = usage.data?.days ?? rangeDays(range);

  return (
    <div className="flex h-screen flex-col bg-outer-background">
      <header className="shrink-0 border-b border-border">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <a href="https://useautumn.com" target="_blank" rel="noreferrer">
              <img src="/autumn-logo.svg" alt="Autumn" className="h-7 w-7" />
            </a>
            <div className="flex flex-col leading-tight">
              <span className="text-sm font-semibold">Summer</span>
              <span className="text-[11px] text-tertiary-foreground">
                by{" "}
                <a
                  href="https://useautumn.com"
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground hover:underline"
                >
                  Autumn
                </a>
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end leading-tight">
            {me.data?.org?.name && (
              <a
                href={me.data.appUrl ?? "https://app.useautumn.com"}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-sm font-medium text-foreground transition-colors hover:text-primary"
              >
                {me.data.org.name}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <span className="text-[11px] text-tertiary-foreground">{me.data?.user?.email}</span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 gap-4 px-6 py-4">
        {/* Left: filters + user list (1/3) */}
        <div className="flex w-full max-w-sm shrink-0 flex-col gap-3">
          <GroupByCard value={groupBy} onChange={setGroupBy} />
          <FilterCard facets={facets} filters={filters} onChange={setFilters} />
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-2 text-sm font-medium text-foreground">Users</div>
            <UserList
              customers={customers.data?.list ?? []}
              isLoading={customers.isLoading}
              search={search}
              onSearch={setSearch}
              selectedId={customerId}
              onSelect={setSelected}
              usageByEmail={usageByEmail}
            />
          </div>
        </div>

        {/* Right: detail (2/3) */}
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          {selected && <UserCard customer={selected} />}

          <Card className="shrink-0 overflow-hidden">
            <div className="flex items-start justify-between px-5 pt-4">
              <div>
                <div className="text-xs text-tertiary-foreground">
                  {selected ? selected.email ?? selected.name : "All users"} ·{" "}
                  {usage.data?.count ?? 0} events
                </div>
                <div className="text-2xl font-semibold tabular-nums">{usd(usage.data?.total)}</div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 rounded-lg border border-border bg-interactive-secondary px-2.5 py-1.5">
                  <DateInput
                    valueMs={range.start}
                    label={formatRangeLabel(range.start)}
                    max={range.end}
                    align="start"
                    onPick={(start) => setRange((r) => ({ ...r, start }))}
                  />
                  <span className="text-tertiary-foreground">→</span>
                  <DateInput
                    valueMs={range.end}
                    label={formatRangeLabel(range.end, { isEnd: true })}
                    isEnd
                    min={range.start}
                    align="end"
                    onPick={(end) => setRange((r) => ({ ...r, end }))}
                  />
                  {activePreset !== 30 && (
                    <button
                      type="button"
                      onClick={() => setRange(presetRange(30))}
                      title="Reset to last 30 days"
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-tertiary-foreground transition-colors hover:bg-interactive-secondary-hover hover:text-foreground"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex rounded-lg border border-border bg-interactive-secondary p-1">
                  {RANGE_PRESETS.map((r) => (
                    <button
                      key={r.days}
                      type="button"
                      onClick={() => setRange(presetRange(r.days))}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        activePreset === r.days
                          ? "bg-active-primary text-foreground shadow-sm ring-1 ring-inset ring-white/10"
                          : "text-tertiary-foreground hover:text-foreground"
                      )}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="relative mt-3 flex h-64 flex-col overflow-hidden">
              {(usage.isLoading || hasChart) && (
                <div className="absolute inset-0 flex flex-col">
                  <ChartSkeleton
                    barCount={barCount}
                    targets={hasChart ? barFractions : null}
                    geometry={plotInsets}
                  />
                </div>
              )}
              <AnimatePresence>
                {hasChart && usage.data && (
                  <motion.div
                    key="chart"
                    className="absolute inset-0 flex flex-col bg-card"
                    initial={{ opacity: 0 }}
                    animate={{
                      opacity: 1,
                      transition: { duration: 0.85, delay: revealDelay, ease: [0.23, 1, 0.32, 1] }
                    }}
                    exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  >
                    <ChartLegend entries={legendEntries} showLabels={groupBy !== "none" || legendEntries.length <= 3} />
                    <div className="min-h-0 flex-1">
                      <UsageChart data={usage.data} domainMax={domainMax} onGeometry={handlePlotGeometry} />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
              {isEmpty && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                  <BarChart3 className="h-7 w-7 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">No usage for these filters.</p>
                </div>
              )}
            </div>
          </Card>

          <EventsTable
            events={events.data?.list ?? []}
            isLoading={events.isLoading}
            count={events.data?.list?.length ?? 0}
          />
        </div>
      </div>
    </div>
  );
}
