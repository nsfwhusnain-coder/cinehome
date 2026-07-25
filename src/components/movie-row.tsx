"use client";

import {
  Children,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

/** Shared with hero text block — 56px. */
export const RAIL_PAD_LEFT = 56;

interface Props {
  title: string;
  children: ReactNode;
  className?: string;
  viewAllHref?: string;
  titleNode?: ReactNode;
  /** Pencil action for Continue Watching (instead of View all). */
  editHref?: string;
}

export function MovieRow({
  title,
  children,
  className,
  viewAllHref,
  titleNode,
  editHref,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [hovering, setHovering] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanLeft(scrollLeft > 0);
    setCanRight(scrollLeft + clientWidth < scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener("scroll", updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      ro.disconnect();
    };
  }, [updateArrows, children]);

  const scrollByDir = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = Math.max(280, Math.floor(el.clientWidth * 0.75));
    el.scrollBy({ left: dir * amount, behavior: "smooth" });
  };

  const childCount = Children.count(children);

  return (
    <section
      className={cn("group/rail relative", className)}
      aria-label={title}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div
        className="mb-3 flex items-center justify-between gap-3 pr-4 sm:pr-6"
        style={{ paddingLeft: RAIL_PAD_LEFT }}
      >
        <h2 className="font-display flex items-center gap-2 text-[22px] font-semibold leading-none tracking-tight text-white">
          {titleNode ?? title}
        </h2>
        {editHref ? (
          <Link
            href={editHref}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Manage continue watching"
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Link>
        ) : viewAllHref ? (
          <Link
            href={viewAllHref}
            className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-white/60 transition-colors hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ fontSize: 14 }}
          >
            View all
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </div>

      <div className="relative">
        {/* Left fade ONLY once scrolled — never clips the first card at rest */}
        {/* Soft edge fades — transparent so ambient wash still reads through */}
        {canLeft ? (
          <div
            className="pointer-events-none absolute inset-y-0 left-0 z-[5] w-10"
            style={{
              background: "linear-gradient(90deg, rgba(10,10,15,0.85) 0%, transparent 100%)",
            }}
            aria-hidden
          />
        ) : null}
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-[5] w-10"
          style={{
            background: "linear-gradient(270deg, rgba(10,10,15,0.85) 0%, transparent 100%)",
          }}
          aria-hidden
        />

        {canLeft && hovering ? (
          <button
            type="button"
            onClick={() => scrollByDir(-1)}
            className="absolute left-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/50 text-white backdrop-blur-md transition-opacity hover:bg-black/70"
            style={{ left: RAIL_PAD_LEFT }}
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden />
          </button>
        ) : null}
        {canRight && hovering ? (
          <button
            type="button"
            onClick={() => scrollByDir(1)}
            className="absolute right-2 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/25 bg-black/50 text-white backdrop-blur-md transition-opacity hover:bg-black/70"
            aria-label="Scroll right"
          >
            <ChevronRight className="h-5 w-5" aria-hidden />
          </button>
        ) : null}

        <div
          ref={scrollerRef}
          className="scrollbar-hide flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1 pt-1"
          style={{
            paddingLeft: RAIL_PAD_LEFT,
            scrollPaddingLeft: RAIL_PAD_LEFT,
            paddingRight: 24,
          }}
        >
          {Children.map(children, (child) => (
            <div className="shrink-0 snap-start" style={{ scrollSnapAlign: "start" }}>
              {child}
            </div>
          ))}
          {childCount > 0 ? <div className="w-2 shrink-0" aria-hidden /> : null}
        </div>
      </div>
    </section>
  );
}
