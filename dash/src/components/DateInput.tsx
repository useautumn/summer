import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { fromDateInputEnd, fromDateInputStart } from "@/lib/range";
import { cn } from "@/lib/utils";

const pad = (n: number) => String(n).padStart(2, "0");
/** A UTC epoch-ms -> a local Date for the same calendar day (so the right cell highlights). */
const toCalendarDate = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const calendarKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function DateInput({
  valueMs,
  label,
  isEnd,
  min,
  max,
  align = "start",
  onPick
}: {
  valueMs: number;
  label: string;
  isEnd?: boolean;
  min?: number;
  max?: number;
  align?: "start" | "end";
  onPick: (ms: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleSelect = (day: Date | undefined) => {
    if (!day) return;
    const key = calendarKey(day);
    onPick(isEnd ? fromDateInputEnd(key) : fromDateInputStart(key));
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 whitespace-nowrap text-xs text-foreground transition-colors hover:text-primary"
      >
        <CalendarIcon className="h-3.5 w-3.5 text-tertiary-foreground" />
        {label}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className={cn(
              "absolute top-full z-50 mt-2 rounded-lg border border-border bg-popover shadow-xl",
              align === "end" ? "right-0" : "left-0"
            )}
            initial={{ opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4 }}
            transition={{ duration: 0.14, ease: [0.23, 1, 0.32, 1] }}
          >
            <Calendar
              mode="single"
              selected={toCalendarDate(valueMs)}
              defaultMonth={toCalendarDate(valueMs)}
              onSelect={handleSelect}
              disabled={[
                ...(min != null ? [{ before: toCalendarDate(min) }] : []),
                ...(max != null ? [{ after: toCalendarDate(max) }] : [])
              ]}
              fromYear={2024}
              toYear={new Date().getFullYear() + 1}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
