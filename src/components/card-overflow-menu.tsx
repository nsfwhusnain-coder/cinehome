"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useSession } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/hooks/use-navigate";
import { useWatchlist, type WatchlistItem } from "@/hooks/use-watchlist";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useIsTv } from "@/hooks/use-is-tv";

export interface CardMenuTarget {
  tmdbId: number;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  season?: number | null;
  episode?: number | null;
  duration?: number | null;
  position?: number | null;
  /** Show "Remove from Continue Watching" */
  continueWatching?: boolean;
}

interface Props {
  target: CardMenuTarget;
  className?: string;
  /** Always show button (e.g. for tests); default: reveal on group-hover */
  alwaysVisible?: boolean;
}

const GLASS: React.CSSProperties = {
  background: "rgba(255,255,255,0.12)",
  WebkitBackdropFilter: "blur(18px) saturate(180%) brightness(1.15)",
  backdropFilter: "blur(18px) saturate(180%) brightness(1.15)",
  boxShadow: "0 12px 32px rgba(0,0,0,0.5), inset 0 1px 1.5px rgba(255,255,255,0.45)",
};

/**
 * Card "..." control: outside the card link's navigation path.
 * stopPropagation on pointerdown + click so the card never navigates.
 */
export function CardOverflowMenu({ target, className, alwaysVisible }: Props) {
  const isTv = useIsTv();
  const { data: session } = useSession();
  const { isIn, add, remove } = useWatchlist();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const mediaType = target.mediaType === "tv" ? "tv" : "movie";
  const inList = session?.user?.id ? isIn(target.tmdbId, mediaType) : false;
  const detailHref = `/${mediaType}/${target.tmdbId}`;

  const stopCard = (e: ReactPointerEvent | MouseEvent | KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const close = useCallback(() => setOpen(false), []);

  const openMenu = (e: ReactPointerEvent | MouseEvent) => {
    stopCard(e);
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const menuW = 220;
      let left = rect.right - menuW;
      if (left < 8) left = 8;
      if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      let top = rect.bottom + 6;
      if (top + 200 > window.innerHeight) top = rect.top - 200;
      setPos({ top, left });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: Event) => {
      const t = ev.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => itemRefs.current[0]?.focus());
    }
  }, [open]);

  const watchlistItem: WatchlistItem = {
    tmdbId: target.tmdbId,
    mediaType,
    title: target.title,
    poster: target.poster ?? null,
    backdrop: target.backdrop ?? null,
  };

  const removeContinue = async () => {
    const params = new URLSearchParams({
      tmdbId: String(target.tmdbId),
      mediaType,
    });
    if (mediaType === "tv" && target.season != null && target.episode != null) {
      params.set("season", String(target.season));
      params.set("episode", String(target.episode));
    }
    const res = await fetch(`/api/progress?${params}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Could not remove from Continue Watching");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["progress"] });
    toast.success("Removed from Continue Watching");
    close();
  };

  const toggleList = () => {
    if (!session?.user?.id) {
      toast.error("Sign in to use My List");
      close();
      return;
    }
    // Toasts live in useWatchlist mutations — do not double-fire here.
    if (inList) {
      remove.mutate({ tmdbId: target.tmdbId, mediaType });
    } else {
      add.mutate(watchlistItem);
    }
    close();
  };

  const goDetails = () => {
    close();
    navigate(detailHref);
  };

  const markWatched = async () => {
    const duration =
      target.duration && target.duration > 0 ? target.duration : 1;
    const res = await fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdbId: target.tmdbId,
        mediaType,
        title: target.title,
        poster: target.poster ?? null,
        backdrop: target.backdrop ?? null,
        progress: 1,
        position: duration,
        duration,
        season: mediaType === "tv" ? target.season ?? 1 : 0,
        episode: mediaType === "tv" ? target.episode ?? 1 : 0,
      }),
    });
    if (!res.ok) {
      toast.error("Could not mark as watched");
      return;
    }
    await qc.invalidateQueries({ queryKey: ["progress"] });
    toast.success("Marked as watched");
    close();
  };

  const items: { label: string; action: () => void; danger?: boolean }[] = [];
  if (target.continueWatching) {
    items.push({ label: "Remove from Continue Watching", action: removeContinue, danger: true });
  }
  items.push({
    label: inList ? "Remove from My List" : "Add to My List",
    action: toggleList,
  });
  items.push({ label: "Go to details", action: goDetails });
  items.push({ label: "Mark as watched", action: markWatched });

  const onMenuKey = (e: KeyboardEvent, idx: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      itemRefs.current[(idx + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      itemRefs.current[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      itemRefs.current[items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  };

  const menu =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Card actions"
            className="fixed z-[200] min-w-[200px] overflow-hidden rounded-xl border border-white/25 py-1"
            style={{ ...GLASS, top: pos.top, left: pos.left }}
          >
            {items.map((item, i) => (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                className={cn(
                  "flex w-full px-3.5 py-2.5 text-left text-sm transition-colors",
                  "text-white/90 hover:bg-white/12 focus:bg-white/12 focus:outline-none",
                  item.danger && "text-red-300 hover:text-red-200"
                )}
                onClick={(e) => {
                  stopCard(e);
                  item.action();
                }}
                onPointerDown={stopCard}
                onKeyDown={(e) => onMenuKey(e, i)}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )
      : null;

  const tvVisible = isTv || alwaysVisible;

  return (
    <>
      {/* 44px hit area (48px on TV), 32px visual. Hover-reveal on pointer; always on TV. */}
      <button
        ref={btnRef}
        type="button"
        data-card-overflow=""
        className={cn(
          "absolute right-1 top-1 z-30 flex items-center justify-center",
          isTv ? "h-12 w-12" : "h-11 w-11",
          "transition-opacity duration-[180ms] ease-out",
          tvVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
          "focus-visible:outline-none",
          className
        )}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onPointerDown={stopCard}
        onClick={openMenu}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            stopCard(e);
            openMenu(e as unknown as MouseEvent);
          }
        }}
      >
        <span
          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/40 text-white"
          style={{
            background: "rgba(255,255,255,0.16)",
            WebkitBackdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
            backdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
            boxShadow: "inset 0 1px 1px rgba(255,255,255,0.5)",
          }}
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden />
        </span>
      </button>
      {menu}
    </>
  );
}
