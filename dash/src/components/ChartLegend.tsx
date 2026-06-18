import { useLayoutEffect, useRef, useState } from "react";

export type ChartLegendEntry = {
  key: string;
  label: string;
  color: string | undefined;
  value: number;
  title: string;
};

const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Horizontal legend that hides tail entries when they would overflow the
 * available width, collapsing them into a `+N more` pill. Ported from
 * autumn/main: measures all entries off-screen, then renders the largest
 * prefix that fits alongside the pill.
 */
export function ChartLegend({
  entries,
  showLabels: explicitShowLabels
}: {
  entries: ChartLegendEntry[];
  showLabels?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(entries.length);

  const showLabels = explicitShowLabels !== undefined ? explicitShowLabels : entries.length <= 3;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const recompute = () => {
      const containerWidth = container.clientWidth;
      if (!containerWidth) return;
      const children = Array.from(measure.children) as HTMLElement[];
      const overflowEl = children[children.length - 1];
      const entryEls = children.slice(0, -1);
      const GAP = 16;
      const overflowWidth = overflowEl?.getBoundingClientRect().width ?? 0;

      let total = 0;
      for (let i = 0; i < entryEls.length; i++) {
        total += entryEls[i].getBoundingClientRect().width + (i > 0 ? GAP : 0);
        if (total > containerWidth) {
          let fitted = 0;
          let running = overflowWidth;
          for (let j = 0; j < entryEls.length; j++) {
            const next =
              running + (j > 0 || fitted > 0 ? GAP : 0) + entryEls[j].getBoundingClientRect().width;
            if (next <= containerWidth) {
              running = next;
              fitted = j + 1;
            } else break;
          }
          setVisibleCount(fitted);
          return;
        }
      }
      setVisibleCount(entryEls.length);
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(container);
    return () => ro.disconnect();
  }, [entries, showLabels]);

  if (entries.length === 0) return null;

  const visible = entries.slice(0, visibleCount);
  const overflow = entries.slice(visibleCount);
  const overflowTotal = overflow.reduce((acc, e) => acc + e.value, 0);

  return (
    <div ref={containerRef} className="relative h-7 shrink-0 overflow-hidden border-b border-border bg-card">
      {/* Off-screen measurement layer. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute -top-[9999px] left-0 flex h-7 items-stretch gap-4 whitespace-nowrap px-5"
      >
        {entries.map((e) => (
          <LegendItem key={e.key} entry={e} showLabel={showLabels} forMeasurement />
        ))}
        <OverflowPill count={entries.length} total={overflowTotal} />
      </div>

      {/* Rendered layer. */}
      <div className="flex h-7 items-stretch gap-4 whitespace-nowrap px-5">
        {visible.map((e) => (
          <LegendItem key={e.key} entry={e} showLabel={showLabels} />
        ))}
        {overflow.length > 0 && (
          <div title={overflow.map((e) => `${e.label}: ${fmt(e.value)}`).join("\n")}>
            <OverflowPill count={overflow.length} total={overflowTotal} />
          </div>
        )}
      </div>
    </div>
  );
}

function LegendItem({
  entry,
  showLabel,
  forMeasurement
}: {
  entry: ChartLegendEntry;
  showLabel: boolean;
  forMeasurement?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={entry.title}>
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: entry.color }} />
      {showLabel && (
        <span
          className={
            forMeasurement
              ? "shrink-0 text-[11px] text-tertiary-foreground"
              : "min-w-0 max-w-[140px] truncate text-[11px] text-tertiary-foreground"
          }
        >
          {entry.label}
        </span>
      )}
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmt(entry.value)}</span>
    </div>
  );
}

function OverflowPill({ count, total }: { count: number; total: number }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-sm bg-tertiary-foreground" />
      <span className="shrink-0 text-[11px] text-tertiary-foreground">+{count} more</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmt(total)}</span>
    </div>
  );
}
