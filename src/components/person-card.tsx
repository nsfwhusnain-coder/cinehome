"use client";

import Link from "next/link";
import { tmdbImageUrl } from "@/lib/tmdb";

interface Props {
  id: number;
  name: string;
  character?: string;
  profilePath: string | null;
}

export function PersonCard({ id, name, character, profilePath }: Props) {
  const img = tmdbImageUrl(profilePath, "original");
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Link
      href={`/person/${id}`}
      className="group flex flex-col items-center gap-2 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-xl"
      aria-label={`View ${name}`}
    >
      <div className="relative aspect-square w-full max-w-24 overflow-hidden rounded-full bg-muted ring-1 ring-border transition-all duration-300 group-hover:ring-2 group-hover:ring-primary">
        {img ? (
          <img
            src={img}
            alt=""
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-muted-foreground">
            {initials}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium line-clamp-1">{name}</div>
        {character && <div className="text-[10px] text-muted-foreground line-clamp-1">{character}</div>}
      </div>
    </Link>
  );
}
