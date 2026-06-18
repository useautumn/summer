import { useMemo } from "react";
import { useReducedMotion } from "motion/react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  bandGridStyle,
  buildSkeletonBars,
  DEFAULT_PLOT_INSETS,
  type PlotInsets
} from "@/lib/chartGeometry";
import { SkeletonBar } from "./SkeletonBar";

const Y_POSITIONS = [0, 25, 50, 75, 100] as const;
const X_LABELS = 7;

/** Loading placeholder for the usage chart that morphs into the real chart. */
export function ChartSkeleton({
  barCount,
  targets,
  geometry = DEFAULT_PLOT_INSETS
}: {
  barCount: number;
  targets?: number[] | null;
  geometry?: PlotInsets;
}) {
  const prefersReducedMotion = useReducedMotion();
  const settledHeights = targets && targets.length > 0 ? targets : null;
  const count = settledHeights?.length ?? Math.max(6, barCount);
  const bars = useMemo(() => buildSkeletonBars(count), [count]);

  return (
    <div className="relative flex flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-4 border-b border-border bg-card px-2">
        {[72, 56, 64].map((width, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Skeleton className="size-2 rounded-sm" />
            <Skeleton className="h-2.5 rounded-sm" style={{ width }} />
            <Skeleton className="h-2.5 w-8 rounded-sm" />
          </div>
        ))}
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col"
        style={{ paddingTop: geometry.top, paddingRight: geometry.right }}
      >
        <div className="flex min-h-0 flex-1">
          <div className="relative shrink-0" style={{ width: geometry.left }}>
            {Y_POSITIONS.map((top) => (
              <Skeleton
                key={top}
                className="absolute right-2 h-2 w-5 -translate-y-1/2 rounded-sm"
                style={{ top: `${top}%` }}
              />
            ))}
          </div>

          <div className="relative min-w-0 flex-1" style={bandGridStyle(count)}>
            <div className="pointer-events-none absolute inset-0">
              {Y_POSITIONS.map((top) => (
                <div
                  key={top}
                  className="absolute inset-x-0 border-t border-dashed"
                  style={{ top: `${top}%`, borderColor: "var(--chart-grid-stroke)" }}
                />
              ))}
            </div>
            {bars.map((bar, i) => (
              <SkeletonBar
                key={i}
                bar={bar}
                targetHeight={settledHeights ? settledHeights[i] : null}
                reducedMotion={!!prefersReducedMotion}
              />
            ))}
          </div>
        </div>

        <div
          className="flex shrink-0 justify-between pt-1"
          style={{ height: geometry.bottom, paddingLeft: geometry.left }}
        >
          {Array.from({ length: X_LABELS }, (_, i) => (
            <Skeleton key={i} className="h-2 w-6 rounded-sm" />
          ))}
        </div>
      </div>
    </div>
  );
}
