import { NextRequest, NextResponse } from "next/server";
import { fetchSubtitlesForTitle } from "@/lib/subtitles/subtitles-service";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const tmdbIdParam = url.searchParams.get("tmdbId");
  const mediaTypeParam = url.searchParams.get("mediaType");
  const seasonParam = url.searchParams.get("season");
  const episodeParam = url.searchParams.get("episode");

  if (!tmdbIdParam || !mediaTypeParam) {
    return NextResponse.json({ error: "Missing tmdbId or mediaType" }, { status: 400 });
  }

  const tmdbId = Number(tmdbIdParam);
  const mediaType = mediaTypeParam === "tv" ? "tv" : "movie";
  const season = seasonParam ? Number(seasonParam) : undefined;
  const episode = episodeParam ? Number(episodeParam) : undefined;

  const tracks = await fetchSubtitlesForTitle({
    tmdbId,
    mediaType,
    season,
    episode,
  });

  return NextResponse.json({
    subtitles: tracks,
  }, {
    headers: {
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
