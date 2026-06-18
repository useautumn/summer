import { setMonth, setYear } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { type CaptionProps, DayPicker, useDayPicker, useNavigation } from "react-day-picker";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
] as const;

/** Month + year dropdown caption (ported from autumn/main, using the dash Select). */
function CalendarCaption({ displayMonth }: CaptionProps) {
  const { goToMonth, previousMonth, nextMonth } = useNavigation();
  const { fromYear, toYear } = useDayPicker();

  const startYear = fromYear ?? displayMonth.getFullYear() - 5;
  const endYear = toYear ?? displayMonth.getFullYear() + 5;
  const years: number[] = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);

  return (
    <div className="flex items-center justify-between gap-1">
      <button
        type="button"
        disabled={!previousMonth}
        onClick={() => previousMonth && goToMonth(previousMonth)}
        className="inline-flex size-7 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronLeft className="size-4" />
      </button>

      <div className="flex items-center gap-1.5">
        <Select
          className="h-7 border-none bg-transparent px-2 text-sm font-medium hover:bg-accent"
          value={String(displayMonth.getMonth())}
          onChange={(e) => goToMonth(setMonth(displayMonth, Number(e.target.value)))}
        >
          {MONTHS.map((name, i) => (
            <option key={name} value={String(i)}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          className="h-7 border-none bg-transparent px-2 text-sm font-medium hover:bg-accent"
          value={String(displayMonth.getFullYear())}
          onChange={(e) => goToMonth(setYear(displayMonth, Number(e.target.value)))}
        >
          {years.map((y) => (
            <option key={y} value={String(y)}>
              {y}
            </option>
          ))}
        </Select>
      </div>

      <button
        type="button"
        disabled={!nextMonth}
        onClick={() => nextMonth && goToMonth(nextMonth)}
        className="inline-flex size-7 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout="dropdown-buttons"
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col gap-2",
        month: "flex flex-col gap-4",
        caption: "flex justify-center pt-1 relative items-center w-full",
        caption_label: "hidden",
        caption_dropdowns: "flex items-center gap-2",
        vhidden: "hidden",
        nav: "flex items-center gap-1",
        table: "w-full border-collapse",
        head_row: "flex",
        head_cell: "text-tertiary-foreground rounded-md w-8 font-normal text-[0.8rem]",
        row: "flex w-full mt-2",
        cell: "relative p-0 text-center text-sm focus-within:relative focus-within:z-20 [&:has([aria-selected])]:rounded-md [&:has([aria-selected])]:bg-accent",
        day: "inline-flex items-center justify-center size-8 p-0 font-normal text-muted-foreground rounded-md cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors aria-selected:opacity-100",
        day_selected:
          "bg-primary !text-primary-foreground hover:bg-primary hover:!text-primary-foreground focus:bg-primary focus:!text-primary-foreground",
        day_today: "bg-accent text-accent-foreground font-medium",
        day_outside: "day-outside text-subtle aria-selected:text-subtle",
        day_disabled: "text-subtle opacity-50",
        day_hidden: "invisible",
        ...classNames
      }}
      components={{ Caption: CalendarCaption }}
      {...props}
    />
  );
}
