import type { Metadata } from "next";
import { SearchView } from "@/views/search";

interface SearchParams {
  q?: string;
  genre?: string;
  type?: string;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const { q } = await searchParams;
  const query = q?.trim();
  if (query) {
    return { title: `Search “${query}”` };
  }
  return {
    title: "Search",
    description: "Search movies, TV shows, and people on Absolute Cinema.",
  };
}

export default async function Page({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { q, genre, type } = await searchParams;
  return (
    <SearchView
      initialQuery={q || ""}
      initialGenre={genre}
      initialType={(type as "all" | "movie" | "tv" | "person") || "all"}
    />
  );
}
