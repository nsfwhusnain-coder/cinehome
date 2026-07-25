"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { signOut, useSession } from "next-auth/react";
import { useMemo, useRef } from "react";
import { collapseContinueItems } from "@/lib/continue-watching";

export interface ProgressItem {
  tmdbId: number;
  mediaType: string;
  title: string;
  poster?: string | null;
  backdrop?: string | null;
  progress: number;
  position: number;
  duration: number;
  season?: number | null;
  episode?: number | null;
  providerId?: string | null;
}

const SAVE_DEBOUNCE_MS = 5000;

async function progressRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.ok) return res.json() as Promise<T>;

  const body = (await res.json().catch(() => ({}))) as { error?: string };
  const message = body.error || "Failed to update progress";

  if (res.status === 401) {
    await signOut({ callbackUrl: "/login?error=SessionExpired" });
    throw new Error("Session expired — please sign in again");
  }

  throw new Error(message);
}

export function useProgress() {
  const { data: session } = useSession();
  const qc = useQueryClient();
  const lastSave = useRef(0);

  const { data: items, isLoading } = useQuery({
    queryKey: ["progress"],
    queryFn: () => progressRequest<ProgressItem[]>("/api/progress"),
    enabled: !!session,
  });

  const mutation = useMutation({
    mutationFn: (item: ProgressItem) =>
      progressRequest<ProgressItem>("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["progress"] }),
  });

  const remove = useMutation({
    mutationFn: ({
      tmdbId,
      mediaType,
      season,
      episode,
    }: {
      tmdbId: number;
      mediaType: string;
      season?: number | null;
      episode?: number | null;
    }) => {
      const params = new URLSearchParams({
        tmdbId: String(tmdbId),
        mediaType,
      });
      if (mediaType === "tv" && season != null && episode != null) {
        params.set("season", String(season));
        params.set("episode", String(episode));
      }
      return progressRequest<{ ok: boolean }>(`/api/progress?${params.toString()}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["progress"] }),
  });

  // Debounced save — at most once every 5s, always flushes immediately for progress >= 1 (ended).
  const save = (item: ProgressItem) => {
    const now = Date.now();
    if (item.progress >= 1 || now - lastSave.current > SAVE_DEBOUNCE_MS) {
      lastSave.current = now;
      mutation.mutate(item);
    }
  };

  // Defensive collapse (API also collapses) — one TV card per show.
  const collapsed = useMemo(
    () => collapseContinueItems(items || []),
    [items]
  );

  return { items: collapsed, isLoading, save, remove };
}