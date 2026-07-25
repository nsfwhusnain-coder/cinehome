import type { Metadata } from "next";
import { WatchView } from "@/views/watch";
import { tmdb } from "@/lib/tmdb";

interface SearchParams {
  season?: string;
  episode?: string;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { type, id } = await params;
  const { season, episode } = await searchParams;
  const mediaType = type === "tv" ? "tv" : "movie";
  try {
    if (mediaType === "movie") {
      const data = await tmdb.movieDetails(Number(id));
      const name = data.title || "Movie";
      return { title: `Watch ${name}` };
    }
    const data = await tmdb.tvDetails(Number(id));
    const name = data.name || "Series";
    if (season != null && episode != null) {
      return { title: `Watch ${name} S${season}E${episode}` };
    }
    return { title: `Watch ${name}` };
  } catch {
    return { title: "Watch" };
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ type: string; id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { type, id } = await params;
  const { season, episode } = await searchParams;
  const mediaType = type === "tv" ? "tv" : "movie";

  return (
    <WatchView
      mediaType={mediaType}
      id={Number(id)}
      season={season ? Number(season) : undefined}
      episode={episode ? Number(episode) : undefined}
    />
  );
}
