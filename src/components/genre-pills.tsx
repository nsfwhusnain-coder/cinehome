"use client";

import { useNavigate } from "@/hooks/use-navigate";

interface Genre {
  id: number;
  name: string;
}

interface Props {
  genres: Genre[];
  mediaType: "movie" | "tv";
}

/** Clickable genre chips — route to the matching `/browse/genre-{mediaType}-{id}` hub. */
export function GenrePills({ genres, mediaType }: Props) {
  const navigate = useNavigate();
  if (!genres.length) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {genres.map((g) => (
        <button
          key={g.id}
          type="button"
          onClick={() => navigate(`/browse/genre-${mediaType}-${g.id}`)}
          className="rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-all hover:scale-105 hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {g.name}
        </button>
      ))}
    </div>
  );
}
