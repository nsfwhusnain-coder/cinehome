"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X, Clock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useNavigate } from "@/hooks/use-navigate";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";

export const SEARCH_RECENTS_KEY = "cinehome:search-recents";
export const SEARCH_RECENTS_MAX = 8;

export function loadSearchRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SEARCH_RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((q): q is string => typeof q === "string").slice(0, SEARCH_RECENTS_MAX);
  } catch {
    return [];
  }
}

export function saveSearchRecent(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return loadSearchRecents();
  if (typeof window === "undefined") return [];
  try {
    const list = loadSearchRecents().filter(
      (q) => q.toLowerCase() !== trimmed.toLowerCase()
    );
    list.unshift(trimmed);
    const next = list.slice(0, SEARCH_RECENTS_MAX);
    localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadSearchRecents();
  }
}

export function clearSearchRecents(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(SEARCH_RECENTS_KEY);
  } catch {
    /* ignore */
  }
}

export function removeSearchRecent(query: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const list = loadSearchRecents().filter((r) => r !== query);
    localStorage.setItem(SEARCH_RECENTS_KEY, JSON.stringify(list));
    return list;
  } catch {
    return loadSearchRecents();
  }
}

interface Props {
  initialQuery?: string;
  autoFocus?: boolean;
  size?: "default" | "lg";
  /** Hide the focus dropdown for recents (e.g. when the parent already shows them). */
  hideRecentDropdown?: boolean;
  onRecentsChange?: (recents: string[]) => void;
}

export function SearchBar({
  initialQuery = "",
  autoFocus,
  size = "default",
  hideRecentDropdown = false,
  onRecentsChange,
}: Props) {
  const navigate = useNavigate();
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const [focused, setFocused] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const debouncedValue = useDebounce(value, 300);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync controlled initialQuery from URL
  useEffect(() => setValue(initialQuery), [initialQuery]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- re-read localStorage when focus opens dropdown
  useEffect(() => setRecent(loadSearchRecents()), [focused]);

  // Live debounced search-as-you-type, without spamming browser history.
  useEffect(() => {
    const trimmed = debouncedValue.trim();
    if (trimmed && trimmed !== initialQuery) {
      router.replace(`/search?q=${encodeURIComponent(trimmed)}`);
    }
  }, [debouncedValue, initialQuery, router]);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const runSearch = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const next = saveSearchRecent(trimmed);
    setRecent(next);
    onRecentsChange?.(next);
    setFocused(false);
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  const showRecent =
    !hideRecentDropdown && focused && !value.trim() && recent.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(value);
        }}
      >
        <div className="relative">
          <Search
            className={cn(
              "absolute top-1/2 -translate-y-1/2 text-muted-foreground",
              size === "lg" ? "left-5 h-6 w-6" : "left-3 h-5 w-5"
            )}
          />
          <Input
            autoFocus={autoFocus}
            type="search"
            placeholder="Search for movies or TV shows..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onFocus={() => setFocused(true)}
            className={cn(
              "rounded-full",
              "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-2",
              size === "lg" ? "h-16 pl-14 text-lg" : "h-12 pl-11 text-base"
            )}
          />
        </div>
      </form>

      {showRecent && (
        <div className="absolute inset-x-0 top-full z-20 mt-2 rounded-2xl border border-white/10 bg-popover/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">Recent searches</span>
            <button
              type="button"
              onClick={() => {
                clearSearchRecents();
                setRecent([]);
                onRecentsChange?.([]);
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
          {recent.map((q) => (
            <div
              key={q}
              role="group"
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
            >
              <button
                type="button"
                onClick={() => runSearch(q)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{q}</span>
              </button>
              <button
                type="button"
                aria-label={`Remove “${q}” from recent searches`}
                onClick={() => {
                  const list = removeSearchRecent(q);
                  setRecent(list);
                  onRecentsChange?.(list);
                }}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
