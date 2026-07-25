"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useSession } from "next-auth/react";
import { toast } from "sonner";

export interface WatchlistItem {
  tmdbId: number;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null;
}

async function watchlistRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.ok) return res.json() as Promise<T>;

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  const message = body.error || "Failed to update watchlist";

  if (res.status === 401) {
    await signOut({ callbackUrl: "/login" });
    throw new Error("Session expired — please sign in again");
  }

  throw new Error(message);
}

export function useWatchlist() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const authed = !!session?.user?.id;

  const { data: items, isLoading } = useQuery({
    queryKey: ["watchlist"],
    queryFn: () => watchlistRequest<WatchlistItem[]>("/api/watchlist"),
    enabled: authed,
  });

  const add = useMutation({
    mutationFn: (item: WatchlistItem) =>
      watchlistRequest<WatchlistItem>("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }),
    onMutate: async (item) => {
      await qc.cancelQueries({ queryKey: ["watchlist"] });
      const prev = qc.getQueryData<WatchlistItem[]>(["watchlist"]);
      qc.setQueryData<WatchlistItem[]>(["watchlist"], (old) => {
        const list = old ?? [];
        if (list.some((x) => x.tmdbId === item.tmdbId && x.mediaType === item.mediaType)) {
          return list;
        }
        return [item, ...list];
      });
      return { prev };
    },
    onSuccess: () => {
      toast.success("Added to watchlist");
    },
    onError: (err, _item, ctx) => {
      if (ctx?.prev) qc.setQueryData(["watchlist"], ctx.prev);
      toast.error(err instanceof Error ? err.message : "Failed to update watchlist");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
    },
  });

  const remove = useMutation({
    mutationFn: ({ tmdbId, mediaType }: { tmdbId: number; mediaType: string }) =>
      watchlistRequest<{ ok: boolean }>(
        `/api/watchlist?tmdbId=${tmdbId}&mediaType=${encodeURIComponent(mediaType)}`,
        { method: "DELETE" }
      ),
    onMutate: async ({ tmdbId, mediaType }) => {
      await qc.cancelQueries({ queryKey: ["watchlist"] });
      const prev = qc.getQueryData<WatchlistItem[]>(["watchlist"]);
      qc.setQueryData<WatchlistItem[]>(["watchlist"], (old) =>
        (old ?? []).filter((x) => !(x.tmdbId === tmdbId && x.mediaType === mediaType))
      );
      return { prev };
    },
    onSuccess: () => {
      toast.success("Removed from watchlist");
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["watchlist"], ctx.prev);
      toast.error(err instanceof Error ? err.message : "Failed to update watchlist");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["watchlist"] });
    },
  });

  const isIn = (tmdbId: number, mediaType: string) =>
    !!items?.some((x) => x.tmdbId === tmdbId && x.mediaType === mediaType);

  return { items: items || [], isLoading, add, remove, isIn };
}