"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useSession } from "next-auth/react";
import { useNavigate } from "@/hooks/use-navigate";
import { Clock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tmdbImageUrl } from "@/lib/tmdb";
import { transitionFast } from "@/lib/motion";
import { useProgress } from "@/hooks/use-progress";
import { EmptyContinue } from "@/components/empty-states";
import { SearchResultsSkeleton } from "@/components/skeletons";

const staggerContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0 },
};

function minutesLeft(position: number, duration: number): string {
  const remaining = Math.max(0, Math.round((duration - position) / 60));
  return `${remaining} min left`;
}

function continueHref(item: {
  mediaType: string;
  tmdbId: number;
  season?: number | null;
  episode?: number | null;
}): string {
  if (item.mediaType === "tv" && item.season != null && item.episode != null) {
    return `/watch/tv/${item.tmdbId}?season=${item.season}&episode=${item.episode}`;
  }
  return `/watch/${item.mediaType}/${item.tmdbId}`;
}

export function ContinueWatchingView() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  const { items, isLoading, remove } = useProgress();

  if (!session) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center">
          <Clock className="mx-auto h-12 w-12 text-muted-foreground mb-3" />
          <h1 className="font-display text-xl font-semibold mb-2">Sign in to see your watch history</h1>
          <Button onClick={() => navigate("/login")}>Sign in</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen px-4 pt-20 pb-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="font-display mb-6 text-2xl font-bold sm:text-3xl">Continue Watching</h1>

        {isLoading ? (
          <SearchResultsSkeleton count={6} />
        ) : items.length > 0 ? (
          <motion.div
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            variants={staggerContainer}
            initial="hidden"
            animate="show"
          >
            {items.map((p) => {
              const rawPct = Math.round((p.progress || 0) * 100);
              const pct =
                rawPct < 1 && (p.position ?? 0) > 1
                  ? 1
                  : rawPct;
              const img = tmdbImageUrl(p.backdrop || p.poster, "w780");
              const epLine =
                p.mediaType === "tv" && p.season != null && p.episode != null
                  ? `Continue S${p.season} E${p.episode} · ${pct}% · ${minutesLeft(p.position ?? 0, p.duration ?? 0)}`
                  : `${pct}% watched · ${minutesLeft(p.position ?? 0, p.duration ?? 0)}`;
              const href = continueHref(p);
              return (
                <motion.div
                  key={`${p.mediaType}-${p.tmdbId}`}
                  className="group relative overflow-hidden rounded-xl bg-card transition-transform hover:-translate-y-1"
                  variants={fadeUp}
                  transition={transitionFast}
                >
                  <Link
                    href={href}
                    className="relative block aspect-video bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    aria-label={`Continue ${p.title}`}
                  >
                    {img && <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
                    <div className="absolute bottom-0 inset-x-0 p-3">
                      <div className="text-sm font-semibold text-white line-clamp-1">{p.title}</div>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/20">
                        <div className="h-full bg-white" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1 text-[10px] text-white/70">{epLine}</div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      remove.mutate({
                        tmdbId: p.tmdbId,
                        mediaType: p.mediaType,
                        season: p.season,
                        episode: p.episode,
                      });
                    }}
                    className="absolute right-2 top-2 z-30 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur transition-colors hover:bg-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title="Remove from history"
                    aria-label={`Remove ${p.title} from history`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </motion.div>
              );
            })}
          </motion.div>
        ) : (
          <EmptyContinue />
        )}
      </div>
    </div>
  );
}
