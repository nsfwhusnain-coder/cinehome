import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DetailView } from "@/views/movie-detail";
import { resolvePlayableTitle } from "@/lib/catalog/title-alias.server";
import { detailHref } from "@/lib/catalog/title-alias";
import { tmdb } from "@/lib/tmdb";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const data = await tmdb.movieDetails(Number(id));
    const title = data.title || "Movie";
    const year = data.release_date ? new Date(data.release_date).getFullYear() : null;
    return {
      title: year ? `${title} (${year})` : title,
      description: data.overview?.slice(0, 160) || `Watch ${title} on Absolute Cinema.`,
    };
  } catch {
    return { title: "Movie" };
  }
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tmdbId = Number(id);
  const playable = await resolvePlayableTitle("movie", tmdbId);
  if (playable.mediaType !== "movie" || playable.tmdbId !== tmdbId) {
    redirect(detailHref(playable));
  }
  const data = await tmdb.movieDetails(tmdbId).catch(() => undefined);
  return <DetailView mediaType="movie" id={tmdbId} initialData={data} />;
}
