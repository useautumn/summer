import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  XAxis,
  YAxis
} from "recharts";
import type { QueryResult } from "@/lib/api";
import { CHART_MARGIN, niceTicks, type PlotInsets, Y_AXIS_WIDTH } from "@/lib/chartGeometry";
import { CHART_COLORS, cn, compactNumber, label } from "@/lib/utils";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d: string) => {
  const [, m, day] = String(d).split("-");
  return m && day ? `${Number(day)} ${MONTHS[Number(m)]}` : d;
};

const MAX_TOOLTIP_ITEMS = 5;
const CHART_STYLE = { cursor: "default" } as const;
const X_TICK = { fontSize: 11, fill: "var(--tertiary-foreground)" } as const;
const Y_TICK = {
  fontSize: 11,
  fill: "var(--tertiary-foreground)",
  textAnchor: "middle" as const,
  dx: -15,
  dy: -3
} as const;

type Row = Record<string, number | string>;

export function UsageChart({
  data,
  domainMax,
  onGeometry
}: {
  data: QueryResult;
  domainMax?: number;
  onGeometry?: (insets: PlotInsets) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<Row | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  const config = useMemo(
    () =>
      data.series.map((s, i) => ({
        yKey: s.key,
        fill: CHART_COLORS[i % CHART_COLORS.length],
        yName: label(s.key)
      })),
    [data.series]
  );

  // Measure the real plot rect so the skeleton can mirror it with zero shift.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !onGeometry) return;
    const measure = () => {
      const grid = container.querySelector(".recharts-cartesian-grid");
      if (!grid) return;
      const c = container.getBoundingClientRect();
      const g = grid.getBoundingClientRect();
      if (g.width === 0 || g.height === 0) return;
      onGeometry({
        left: Math.round(g.left - c.left),
        right: Math.round(c.right - g.right),
        top: Math.round(g.top - c.top),
        bottom: Math.round(c.bottom - g.bottom)
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [onGeometry, data]);

  const handleBarEnter = useCallback(
    (dataKey: string) => (entry: { payload?: Row }) => {
      setHoveredKey(dataKey);
      setActiveRow(entry?.payload ?? null);
    },
    []
  );
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoveredKey(null);
    setActiveRow(null);
    setMousePos(null);
  }, []);

  const barHandlers = useMemo(
    () => config.map((s) => handleBarEnter(s.yKey)),
    [config, handleBarEnter]
  );

  const tooltip = useMemo(() => {
    if (!activeRow) return null;
    const all = config
      .map((s) => ({ dataKey: s.yKey, label: s.yName, value: Number(activeRow[s.yKey] ?? 0), color: s.fill }))
      .filter((i) => i.value !== 0);
    const items = hoveredKey
      ? all.filter((i) => i.dataKey === hoveredKey)
      : all.sort((a, b) => b.value - a.value);
    if (!items.length) return null;
    return { period: String(activeRow.period), items };
  }, [activeRow, hoveredKey, config]);

  const visible = tooltip?.items.slice(0, MAX_TOOLTIP_ITEMS) ?? [];
  const overflow = (tooltip?.items.length ?? 0) - visible.length;
  const overflowSum =
    overflow > 0 ? tooltip!.items.slice(MAX_TOOLTIP_ITEMS).reduce((s, i) => s + i.value, 0) : 0;

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative h-full w-full",
        "[&_*:focus]:outline-none",
        "[&_.recharts-bar-rectangle]:transition-opacity [&_.recharts-bar-rectangle]:duration-75",
        "[&:has(.recharts-bar-rectangle:hover)_.recharts-bar-rectangle:not(:hover)]:opacity-35"
      )}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data.rows}
          className="pt-3 pr-2"
          margin={CHART_MARGIN}
          barCategoryGap="10%"
          style={CHART_STYLE}
        >
          <CartesianGrid
            vertical={false}
            strokeDasharray="2 2"
            stroke="var(--chart-grid-stroke)"
            strokeWidth={1}
          />
          <XAxis
            dataKey="period"
            tickLine={false}
            tickMargin={4}
            axisLine={false}
            interval="equidistantPreserveStart"
            tick={X_TICK}
            tickFormatter={fmtDay}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={Y_AXIS_WIDTH}
            tickMargin={0}
            ticks={domainMax != null ? niceTicks(domainMax) : undefined}
            domain={domainMax != null ? [0, domainMax] : undefined}
            tick={Y_TICK}
            tickFormatter={(v) => `$${compactNumber(Number(v))}`}
          />
          {config.map((s, si) => (
            <Bar
              key={s.yKey}
              dataKey={s.yKey}
              stackId="a"
              fill={s.fill}
              activeBar={false}
              style={CHART_STYLE}
              onMouseEnter={barHandlers[si]}
              onMouseMove={barHandlers[si]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>

      {tooltip && mousePos && (
        <div
          className="pointer-events-none absolute z-50 grid min-w-[8rem] items-start gap-1.5 rounded-lg bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={{
            top: mousePos.y - 12,
            ...((containerRef.current?.offsetWidth ?? 0) - mousePos.x < 200
              ? { right: (containerRef.current?.offsetWidth ?? 0) - mousePos.x + 12 }
              : { left: mousePos.x + 12 })
          }}
        >
          <div className="font-medium">{fmtDay(tooltip.period)}</div>
          <div className="grid gap-1">
            {visible.map((item) => (
              <div key={item.dataKey} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: item.color }} />
                <span className="flex-1 truncate text-tertiary-foreground">{item.label}</span>
                <span className="tabular-nums text-muted-foreground">${item.value.toFixed(2)}</span>
              </div>
            ))}
            {overflow > 0 && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="h-2.5 w-2.5 shrink-0" />
                <span className="flex-1">+{overflow} more</span>
                <span className="tabular-nums">${overflowSum.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
