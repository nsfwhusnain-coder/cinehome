import { cn } from "@/lib/utils";
import "./brand-mark.css";

/** Min tile size is 44px. No 40/48 variants. Nav = 56. Compact auto at ≤72. */
export type BrandMarkSize = "nav" | "header" | "hero" | "lg";

interface Props {
  size?: BrandMarkSize;
  className?: string;
  /** @deprecated kept for call-site compat; always live glass */
  glass?: boolean;
}

const SIZE_PX: Record<BrandMarkSize, number> = {
  nav: 56,
  lg: 72,
  header: 140,
  hero: 512,
};

/**
 * Absolute Cinema AB — LIVE transparent glass.
 * Compact physics auto-apply when size ≤ 72px.
 * Must NOT sit inside a parent with backdrop-filter.
 */
export function BrandMark({ size = "nav", className }: Props) {
  const px = SIZE_PX[size];
  const compact = px <= 72;

  return (
    <span
      role="img"
      aria-label="Absolute Cinema"
      className={cn("ab-glass", className)}
      data-size={size}
      data-compact={compact ? "true" : "false"}
      style={{ ["--ab-size" as string]: `${px}px` }}
    >
      <span className="ab-glass__letter-wrap" aria-hidden>
        <span className="ab-glass__letters">AB</span>
      </span>
    </span>
  );
}

/**
 * Nav lockup: [56px glass AB] + 12px + plain "ABSOLUTE CINEMA" wordmark.
 * Kept for settings/footer contexts that still want the full mark.
 */
export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("ab-lockup", className)}>
      <BrandMark size="nav" />
      <span className="ab-lockup__wordmark" aria-hidden>
        Absolute Cinema
      </span>
    </span>
  );
}

/**
 * LordFlix-style minimal lettermark for the main navbar — no glass pill.
 */
export function NavLettermark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Absolute Cinema"
      className={cn("select-none", className)}
      style={{
        fontStyle: "italic",
        fontWeight: 800,
        fontSize: "1.6rem",
        color: "#ffffff",
        letterSpacing: "-0.02em",
        lineHeight: 1,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      A
    </span>
  );
}

interface WordmarkProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** Glass pill wordmark — same liquid-glass recipe as the AB tile (hero/marketing). */
export function BrandWordmark({ size = "md", className }: WordmarkProps) {
  return (
    <span
      role="img"
      aria-label="Absolute Cinema"
      className={cn("ab-glass-pill", className)}
      data-size={size}
    >
      <span className="ab-glass-pill__wrap" aria-hidden>
        <span className="ab-glass-pill__text">Absolute Cinema</span>
      </span>
    </span>
  );
}
