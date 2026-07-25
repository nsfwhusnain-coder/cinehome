import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  value: number;
  size?: "sm" | "lg";
  className?: string;
}

export function RatingBadge({ value, size = "sm", className }: Props) {
  if (!value) return null;
  const rounded = Math.round(value * 10) / 10;
  const color = rounded > 7 ? "text-emerald-400" : rounded > 5 ? "text-amber-400" : "text-red-400";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-semibold tabular-nums",
        color,
        size === "lg" ? "text-base" : "text-xs",
        className
      )}
    >
      <Star className={cn("fill-current", size === "lg" ? "h-4 w-4" : "h-3 w-3")} />
      {rounded}
    </span>
  );
}
