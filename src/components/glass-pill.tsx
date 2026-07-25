"use client";

import { cn } from "@/lib/utils";
import type { ReactNode, CSSProperties } from "react";

/** Shared LordFlix-style clear glass material (nav pill family). */
export const GLASS_PILL_STYLE: CSSProperties = {
  background: "rgba(255,255,255,0.1)",
  WebkitBackdropFilter: "blur(22px) saturate(180%) brightness(1.08)",
  backdropFilter: "blur(22px) saturate(180%) brightness(1.08)",
  boxShadow:
    "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -0.5px 0 rgba(255,255,255,0.08), 0 8px 28px rgba(0,0,0,0.28)",
};

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

interface GlassPillRootProps {
  children: ReactNode;
  className?: string;
}

/** Outer glass capsule container. */
export function GlassPill({ children, className }: GlassPillRootProps) {
  return (
    <div
      className={cn(
        "relative inline-flex h-12 shrink-0 items-center gap-0.5 rounded-full border border-white/20 p-1",
        className
      )}
      style={GLASS_PILL_STYLE}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          padding: 1,
          background:
            "linear-gradient(160deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0.08) 45%, rgba(255,255,255,0.18) 100%)",
          WebkitMask:
            "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          WebkitMaskComposite: "xor",
          mask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
          maskComposite: "exclude",
        }}
      />
      <div className="relative z-[1] flex items-center gap-0.5">{children}</div>
    </div>
  );
}

interface GlassPillSegmentProps {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  type?: "button" | "submit";
  "aria-label"?: string;
}

/** Inset segment — white when active, ghost when idle. */
export function GlassPillSegment({
  active,
  onClick,
  children,
  className,
  type = "button",
  "aria-label": ariaLabel,
}: GlassPillSegmentProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={cn(
        "inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-medium transition-colors duration-200",
        FOCUS,
        active
          ? "bg-white text-black shadow-sm"
          : "text-white/85 hover:bg-white/10 hover:text-white",
        className
      )}
    >
      {children}
    </button>
  );
}

export function GlassPillDivider({ className }: { className?: string }) {
  return (
    <span
      className={cn("mx-0.5 h-4 w-px shrink-0", className)}
      style={{ background: "rgba(255,255,255,0.2)" }}
      aria-hidden
    />
  );
}

interface GlassPillTabsProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}

/** Controlled tab strip in the glass pill look. */
export function GlassPillTabs<T extends string>({
  value,
  options,
  onChange,
  className,
}: GlassPillTabsProps<T>) {
  return (
    <GlassPill className={className}>
      {options.map((opt) => (
        <GlassPillSegment
          key={opt.value}
          active={value === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </GlassPillSegment>
      ))}
    </GlassPill>
  );
}
