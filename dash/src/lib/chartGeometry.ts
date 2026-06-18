import type { CSSProperties } from "react";

/*
 * Single source of truth for the usage chart's layout, shared between the real
 * recharts chart (UsageChart) and the loading skeleton (ChartSkeleton) so the
 * morph between them has zero shift. Ported from autumn/main's analytics chart.
 */

export const CHART_MARGIN = { top: 5, right: 5, bottom: 5, left: 5 } as const;
export const Y_AXIS_WIDTH = 40;
export const X_AXIS_HEIGHT = 30;

/** `pt-3 pr-2` on the BarChart element, in pixels. */
const CHART_PAD = { top: 12, right: 8 } as const;

export const LEFT_GUTTER = CHART_MARGIN.left + Y_AXIS_WIDTH;
export const TOP_INSET = CHART_MARGIN.top + CHART_PAD.top;
export const BOTTOM_INSET = X_AXIS_HEIGHT + CHART_MARGIN.bottom;
export const RIGHT_INSET = CHART_MARGIN.right + CHART_PAD.right;

/** `barCategoryGap="10%"` on the BarChart: bar = 90% of the band, centered. */
export const BAR_CATEGORY_GAP = 0.1;

/** Plot insets (px) from each edge of the chart body. */
export interface PlotInsets {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const DEFAULT_PLOT_INSETS: PlotInsets = {
  left: LEFT_GUTTER,
  right: RIGHT_INSET,
  top: TOP_INSET,
  bottom: BOTTOM_INSET
};

// recharts computes the exact gutter dynamically; the real chart measures its
// plot rect and caches it here so the skeleton (which renders first) mirrors it
// exactly across loads within a session.
let cachedPlotInsets: PlotInsets | null = null;
export const getCachedPlotInsets = (): PlotInsets | null => cachedPlotInsets;
export const setCachedPlotInsets = (insets: PlotInsets): void => {
  cachedPlotInsets = insets;
};
export const plotInsetsEqual = (a: PlotInsets, b: PlotInsets): boolean =>
  a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;

/**
 * CSS grid that reproduces recharts' band layout: each bar is 90% of its band
 * with 5% outer padding and 10% inter-bar gaps. Percentages resolve against the
 * plot width, so no width measurement is needed.
 */
export const bandGridStyle = (count: number): CSSProperties => ({
  display: "grid",
  gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
  columnGap: `${(BAR_CATEGORY_GAP * 100) / count}%`,
  paddingInline: `${(BAR_CATEGORY_GAP * 50) / count}%`,
  alignItems: "end"
});

/** Per-bar geometry + timing for the loading wave. Heights are a scaleY
 * fraction (0-1) of the full plot height. */
export interface SkeletonBarConfig {
  peak: number;
  low: number;
  duration: number;
  delay: number;
  shimmerDelay: number;
  shimmerDuration: number;
}

/** Randomised, stable bar configs for the loading wave. */
export const buildSkeletonBars = (count: number): SkeletonBarConfig[] =>
  Array.from({ length: count }, () => {
    const peak = 0.22 + Math.random() * 0.73;
    return {
      peak,
      low: peak * (0.35 + Math.random() * 0.2),
      duration: 2.6 + Math.random() * 1.8,
      delay: Math.random() * 1.4,
      shimmerDelay: -Math.random() * 3,
      shimmerDuration: 2.6 + Math.random() * 1.6
    };
  });

/** Rounds a value up to a nice number (1/2/5/10 × 10^n). */
const niceNumber = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * magnitude;
};

/** Rounds a value up to a nice axis maximum, matching the headroom recharts
 * leaves above the data so bar heights line up. */
export const niceCeil = niceNumber;

/**
 * Evenly-spaced "nice" axis ticks from 0 up to (at most) `max`. Avoids recharts'
 * habit of mixing a nice step with the domain endpoint (e.g. 0,2,4,5), which
 * produces visibly uneven spacing.
 */
export const niceTicks = (max: number, target = 4): number[] => {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const step = niceNumber(max / target);
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
};
