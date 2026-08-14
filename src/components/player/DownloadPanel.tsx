"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaType, PlaybackSource } from "@/lib/playback/types";
import {
  buildDownloadOptions,
  downloadDetailLine,
  downloadFilename,
  downloadSizeLabel,
  type DownloadOption,
} from "@/lib/playback/download-options";

interface Props {
  sources: PlaybackSource[];
  title: string;
  mediaType: MediaType;
  tmdbId?: number;
  season?: number;
  episode?: number;
  durationSeconds: number;
}

function downloadHref(
  option: DownloadOption,
  props: Props,
  source: PlaybackSource | undefined
): string {
  const params = new URLSearchParams({
    type: props.mediaType,
    id: String(props.tmdbId ?? 0),
    sourceId: option.sourceId,
    height: String(option.height),
    filename: downloadFilename(props.title, option),
  });
  if (props.mediaType === "tv" && props.season != null && props.episode != null) {
    params.set("season", String(props.season));
    params.set("episode", String(props.episode));
  }
  if (source?.remuxTicket) params.set("ticket", source.remuxTicket);
  return `/api/download?${params.toString()}`;
}

export function DownloadPanel({
  sources,
  title,
  mediaType,
  tmdbId,
  season,
  episode,
  durationSeconds,
}: Props) {
  const options = useMemo(
    () => buildDownloadOptions(sources, durationSeconds),
    [sources, durationSeconds]
  );
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    if (!tmdbId || !options.length) return;
    let cancelled = false;
    const missing = options.filter((option) => !option.sizeBytes && !sizes[option.id]);
    if (!missing.length) return;

    const run = async () => {
      for (const option of missing.slice(0, 6)) {
        const source = sources.find((row) => row.id === option.sourceId);
        const href = downloadHref(
          option,
          { sources, title, mediaType, tmdbId, season, episode, durationSeconds },
          source
        );
        try {
          const res = await fetch(`${href}&meta=1`, { credentials: "same-origin" });
          if (!res.ok) continue;
          const body = (await res.json()) as { sizeBytes?: number | null };
          if (!cancelled && body.sizeBytes && body.sizeBytes > 0) {
            setSizes((prev) => ({ ...prev, [option.id]: body.sizeBytes! }));
          }
        } catch {
          /* keep estimate / unknown */
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [options, sources, title, mediaType, tmdbId, season, episode, durationSeconds]);

  const downloadable = options.filter((option) => option.downloadable);

  if (!tmdbId) {
    return (
      <div className="px-2.5 py-4 text-center text-[11px] text-white/50">
        Play a title first, then download.
      </div>
    );
  }

  if (!downloadable.length) {
    return (
      <div className="px-2.5 py-4 text-center text-[11px] leading-snug text-white/50">
        No downloadable file on this title. Adaptive streams stay in the player —
        switch to a file source (Kronos, Quasar, Cinema) if you want a copy.
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
        Choose quality
      </div>
      {downloadable.map((option) => {
        const sized: DownloadOption = {
          ...option,
          sizeBytes: option.sizeBytes ?? sizes[option.id],
        };
        const source = sources.find((row) => row.id === option.sourceId);
        const href = downloadHref(
          option,
          { sources, title, mediaType, tmdbId, season, episode, durationSeconds },
          source
        );
        return (
          <a
            key={option.id}
            href={href}
            download={downloadFilename(title, sized)}
            onClick={() => setPendingId(option.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-xl border border-transparent px-2.5 py-2 text-left text-[13px] text-white/80 transition-colors hover:border-white/10 hover:bg-white/[0.08]"
            )}
          >
            <Download className="h-3.5 w-3.5 shrink-0 text-white/55" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="font-medium text-white">{option.label}</span>
                <span className="shrink-0 tabular-nums text-white/70">
                  {downloadSizeLabel(sized)}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-white/45">
                {downloadDetailLine(sized)}
                {option.origin === "debrid" ? " · Debrid" : ""}
                {option.serverLabel ? ` · ${option.serverLabel}` : ""}
              </span>
            </span>
            {pendingId === option.id ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/45" />
            ) : null}
          </a>
        );
      })}
    </div>
  );
}
