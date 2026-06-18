import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function Select({
  className,
  containerClassName,
  children,
  ...props
}: ComponentProps<"select"> & { containerClassName?: string }) {
  return (
    <div className={cn("relative inline-flex items-center", containerClassName)}>
      <select
        className={cn(
          "h-8 w-full appearance-none rounded-md border border-border bg-input-background pl-2.5 pr-7 text-sm text-foreground",
          "hover:bg-interactive-secondary-hover focus:outline-none focus:ring-2 focus:ring-ring/40",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-tertiary-foreground" />
    </div>
  );
}
